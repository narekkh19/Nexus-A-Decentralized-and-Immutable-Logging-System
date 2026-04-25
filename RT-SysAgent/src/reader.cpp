#include <iostream>
#include <fstream>
#include <csignal>
#include <thread>
#include <atomic>
#include <chrono>
#include <vector>
#include <mutex>
#include <filesystem>
#include <sstream>
#include <cstdio>
#include <array>
#include "shared_memory.hpp"
#include "mmap_queue.hpp"
#include "log_utils.hpp"
#include "json.hpp"
#include "config.hpp"

using json = nlohmann::json;

constexpr size_t QUEUE_SIZE = Config::QueueConfig::DEFAULT_QUEUE_SIZE;
constexpr size_t TEXT_SIZE = Config::QueueConfig::DEFAULT_TEXT_SIZE;
constexpr int NUM_WORKERS = Config::WorkerConfig::DEFAULT_NUM_WORKERS;
constexpr int LOG_THRESHOLD = Config::WorkerConfig::LOG_THRESHOLD;
constexpr int TIME_THRESHOLD_SECONDS = Config::WorkerConfig::TIME_THRESHOLD_SECONDS;
constexpr int WORKER_SLEEP_MS = Config::WorkerConfig::WORKER_SLEEP_MS;
constexpr int FLUSHER_SLEEP_MS = Config::WorkerConfig::FLUSHER_SLEEP_MS;


std::atomic<bool> g_running(true);
std::mutex log_mutex;
std::mutex cid_mutex;
std::vector<json> log_bucket;
std::string g_prev_cid = "null";
std::string g_ipns_id = "";
std::chrono::steady_clock::time_point last_push_time;

struct RawEvent {
    uint8_t type; // 0 = SYSLOG_LINE, 1 = USB_EVENT
    uint64_t event_id;
    char text[TEXT_SIZE];
};
using QueueType = MmapQueue<RawEvent, QUEUE_SIZE>;

void signal_handler(int) {
    g_running = false;
}

int fast_system(const std::string& cmd) {
    std::array<char, 128> buffer;
    FILE* pipe = popen((cmd + " 2>&1").c_str(), "r");
    if (!pipe) return -1;
    while (fgets(buffer.data(), buffer.size(), pipe) != nullptr);
    return pclose(pipe);
}

std::string get_ipns_id_for_key(const std::string& key_name) {
    FILE* pipe = popen("ipfs key list -l", "r");
    if (!pipe) throw std::runtime_error("Failed to run 'ipfs key list -l'");
    char buffer[256];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        std::istringstream iss(buffer);
        std::string peer_id, name;
        iss >> peer_id >> name;
        if (name == key_name) {
            pclose(pipe);
            return peer_id;
        }
    }
    pclose(pipe);
    throw std::runtime_error("IPNS key '" + key_name + "' not found.\nTry: ipfs key gen log-agent --type=rsa --size=2048\nipfs daemon --routing=dhtclient\n");
}

std::string resolve_ipns(const std::string& ipns_id) {
    std::string cmd = "ipfs name resolve --nocache /ipns/" + ipns_id + " --timeout=5s";
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) return "null";
    char buffer[256];
    std::string result;
    while (fgets(buffer, sizeof(buffer), pipe)) result += buffer;
    pclose(pipe);
    if (result.rfind("/ipfs/", 0) == 0)
        return result.substr(6);
    return "null";
}

bool publish_with_retry(const std::string& cid, int retries = 3) {
    for (int attempt = 1; attempt <= retries; ++attempt) {
        std::string publish_cmd =
            "ipfs name publish --key=" + Config::ipfs.ipns_key_name +
            " --allow-offline --ttl=" + std::to_string(Config::IPFSConfig::IPNS_TTL_SECONDS) + "s /ipfs/" + cid;
        int ret = fast_system(publish_cmd);
        if (ret == 0) {
            std::cout << "[IPNS] Head updated to: " << cid << "\n";
            return true;
        }
        std::cerr << "[IPNS] Publish attempt " << attempt << "/" << retries << " failed.\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(500 * attempt));
    }
    return false;
}

void push_log_bucket_if_needed(bool force = false) {
    std::lock_guard<std::mutex> lock(log_mutex);
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_push_time).count();
    if (!force && log_bucket.size() < LOG_THRESHOLD && elapsed < TIME_THRESHOLD_SECONDS)
        return;
    if (log_bucket.empty()) return;

    std::vector<std::string> raw_logs;
    for (const auto& log : log_bucket) raw_logs.push_back(log.dump());

    std::string prev_cid;
    {
        std::lock_guard<std::mutex> cid_lock(cid_mutex);
        prev_cid = g_prev_cid;
    }

    std::string payload = format_logs_json(raw_logs, prev_cid);

    try {
        std::string pubkey_path = Config::encryption.public_key_path;
        std::vector<uint8_t> aes_key = generate_random_bytes(32);
        std::vector<uint8_t> iv, tag;
        std::vector<uint8_t> ciphertext = aes_gcm_encrypt(payload, aes_key, iv, tag);
        std::vector<uint8_t> encrypted_key = rsa_encrypt_key(aes_key, pubkey_path);
        std::string encrypted_file = Config::dirs.get_tmp_path() + "/log_batch.json.enc";
        write_minimal_encrypted_json(encrypted_file, ciphertext, iv, tag, encrypted_key);

        std::string cid;
        for (int attempt = 1; attempt <= 3; ++attempt) {
            cid = ipfs_add(encrypted_file);
            if (!cid.empty()) break;
            std::cerr << "[IPFS] Add attempt " << attempt << "/3 failed.\n";
            std::this_thread::sleep_for(std::chrono::milliseconds(500 * attempt));
        }
        if (cid.empty()) {
            throw std::runtime_error("Failed to add encrypted log batch to IPFS after retries.");
        }
        std::cout << "[IPFS] Pushed CID: " << cid << "\n";

        {
            std::lock_guard<std::mutex> cid_lock(cid_mutex);
            g_prev_cid = cid;
        }

        if (!publish_with_retry(cid, 3)) {
            std::cerr << "[IPNS] Failed to update IPNS head.\n";
        }

        log_bucket.clear();
        last_push_time = std::chrono::steady_clock::now();
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Push failed: " << e.what() << "\n";
    }
}

void worker_thread(int id, QueueType* queue) {
    while (g_running) {
        RawEvent ev{};
        if (queue->dequeue(ev)) {
            json log_entry = {
                {"event_id", ev.event_id},
                {"type", ev.type == 0 ? "SYSLOG" : ev.type == 1 ? "USB" : "SYSTEM"},
                {"message", std::string(ev.text)},
                {"timestamp", current_timestamp()}
            };
            {
                std::lock_guard<std::mutex> lock(log_mutex);
                log_bucket.push_back(log_entry);
            }
            std::cout << "[" << log_entry["type"] << "][Worker " << id << "] " << ev.text << "\n";
            push_log_bucket_if_needed();
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(WORKER_SLEEP_MS));
        }
    }
}

void periodic_flusher() {
    while (g_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(FLUSHER_SLEEP_MS));
        push_log_bucket_if_needed();
    }
}

void ensure_directories() {
    std::filesystem::create_directories(Config::dirs.get_tmp_path());
}

int main() {
    std::cout << ":rocket: Reader initializing...\n";
    
    // Initialize configuration
    Config::initialize_config();
    Config::load_config_from_file();
    
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    ensure_directories();

    try {
        g_ipns_id = get_ipns_id_for_key(Config::ipfs.ipns_key_name);
        g_prev_cid = resolve_ipns(g_ipns_id);
        std::cout << "[IPNS] Bootstrapped from: " << g_prev_cid << "\n";
    } catch (const std::exception& e) {
        std::cerr << "[IPNS] Could not bootstrap IPNS: " << e.what() << "\n";
    }

    SharedMemory<QueueType> shm(Config::shared_memory.queue_file_path, false);
    QueueType* queue = shm.get();

    log_bucket.reserve(LOG_THRESHOLD * 2);
    last_push_time = std::chrono::steady_clock::now();

    std::vector<std::thread> pool;
    for (int i = 0; i < NUM_WORKERS; ++i)
        pool.emplace_back(worker_thread, i, queue);

    std::thread flusher(periodic_flusher);

    for (auto& t : pool) t.join();
    flusher.join();

    push_log_bucket_if_needed(true);
    std::cout << ":checkered_flag: Reader shutdown.\n";
    exit(EXIT_SUCCESS);
}