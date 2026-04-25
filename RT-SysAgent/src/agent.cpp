#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <csignal>
#include <unistd.h>
#include <unordered_map>
#include <fcntl.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <poll.h>
#include <cstring>
#include <cerrno>
#include <filesystem>
#include <libudev.h>
#include <dirent.h>
#include <systemd/sd-daemon.h>

#include "aho_corasick.hpp"
#include "mmap_queue.hpp"
#include "shared_memory.hpp"
#include "patterns.hpp"
#include "config.hpp"

constexpr size_t QUEUE_SIZE = Config::QueueConfig::DEFAULT_QUEUE_SIZE;
constexpr size_t TEXT_SIZE = Config::QueueConfig::DEFAULT_TEXT_SIZE;

struct RawEvent {
    uint8_t type; // 0 = SYSLOG_LINE, 1 = USB_EVENT, 2 = FILE_DELETE
    uint64_t event_id;
    char text[TEXT_SIZE];
};
using QueueType = MmapQueue<RawEvent, QUEUE_SIZE>;

std::atomic<bool> g_running(true);
std::atomic<uint64_t> g_event_counter(0);

void signal_handler(int) {
    g_running = false;
}

void syslog_monitor(QueueType* queue) {
    const std::string& SYSLOG_PATH = Config::system_monitor.syslog_path;

    auto patterns = load_patterns();
    aho_corasick::trie trie;
    for (const auto& pat : patterns) trie.insert(pat);

    int fd = open(SYSLOG_PATH.c_str(), O_RDONLY);
    if (fd < 0) return;

    struct stat st;
    fstat(fd, &st);
    off_t last_offset = st.st_size;

    int inotify_fd = inotify_init1(IN_NONBLOCK);
    int wd = inotify_add_watch(inotify_fd, SYSLOG_PATH.c_str(), IN_MODIFY);

    char buf[Config::SystemMonitorConfig::SYSLOG_BUFFER_SIZE];
    while (g_running) {
        pollfd pfd{inotify_fd, POLLIN, 0};
        if (poll(&pfd, 1, Config::WorkerConfig::MONITOR_POLL_MS) <= 0) continue;

        ssize_t inotify_bytes = read(inotify_fd, buf, sizeof(buf));
        if (inotify_bytes < 0) continue;

        fstat(fd, &st);
        if (st.st_size <= last_offset) continue;

        size_t to_read = st.st_size - last_offset;
        lseek(fd, last_offset, SEEK_SET);
        std::string data(to_read, '\0');
        ssize_t syslog_bytes = read(fd, data.data(), to_read);
        if (syslog_bytes < 0) continue;
        last_offset = st.st_size;

        size_t pos = 0;
        while (pos < data.size()) {
            size_t nl = data.find('\n', pos);
            if (nl == std::string::npos) break;
            std::string line = data.substr(pos, nl - pos);
            pos = nl + 1;

            // Ignore noisy desktop tracker warnings that flood demo output.
            if (line.find("tracker-miner-fs-3") != std::string::npos &&
                line.find("GLib-GIO-WARNING") != std::string::npos &&
                line.find("/proc/self/mountinfo") != std::string::npos) {
                continue;
            }

            if (!trie.parse_text(line).empty()) {
                RawEvent ev{};
                ev.type = 0;
                ev.event_id = g_event_counter.fetch_add(1);
                strncpy(ev.text, line.c_str(), TEXT_SIZE - 1);
                std::cout << "[SYSLOG] " << ev.text << "\n";
                while (!queue->enqueue(ev)) std::this_thread::yield();
            }
        }
    }

    inotify_rm_watch(inotify_fd, wd);
    close(inotify_fd);
    close(fd);
}

void usb_monitor(QueueType* queue) {
    struct udev* udev = udev_new();
    struct udev_monitor* mon = udev_monitor_new_from_netlink(udev, "udev");
    udev_monitor_filter_add_match_subsystem_devtype(mon, "usb", "usb_device");
    udev_monitor_enable_receiving(mon);
    int fd = udev_monitor_get_fd(mon);

    while (g_running) {
        pollfd pfd{fd, POLLIN, 0};
        if (poll(&pfd, 1, Config::WorkerConfig::MONITOR_POLL_MS) <= 0) continue;

        struct udev_device* dev = udev_monitor_receive_device(mon);
        if (!dev) continue;

        const char* action = udev_device_get_action(dev);
        const char* vendor = udev_device_get_sysattr_value(dev, "idVendor");
        const char* product = udev_device_get_sysattr_value(dev, "idProduct");
        const char* devnode = udev_device_get_devnode(dev);

        if (action) {
            std::string msg = "USB device ";
            msg += action;
            if (vendor && product) msg += " (Vendor: " + std::string(vendor) + ", Product: " + std::string(product) + ")";
            if (devnode) msg += " at " + std::string(devnode);

            RawEvent ev{};
            ev.type = 1;
            ev.event_id = g_event_counter.fetch_add(1);
            strncpy(ev.text, msg.c_str(), TEXT_SIZE - 1);
            std::cout << "[USB] " << ev.text << "\n";
            while (!queue->enqueue(ev)) std::this_thread::yield();
        }

        udev_device_unref(dev);
    }

    udev_monitor_unref(mon);
    udev_unref(udev);
}

void file_delete_monitor(QueueType* queue) {
    const std::vector<std::string>& watch_paths = Config::file_monitor.watch_paths;

    int inotify_fd = inotify_init1(IN_NONBLOCK);
    if (inotify_fd < 0) {
        std::cerr << "inotify init failed\n";
        return;
    }

    std::unordered_map<int, std::string> wd_to_path;

    auto add_watch = [&](const std::string& dir_path) {
        int wd = inotify_add_watch(
            inotify_fd,
            dir_path.c_str(),
            IN_DELETE | IN_MOVED_FROM | IN_CREATE | IN_MOVED_TO
        );
        if (wd >= 0) {
            wd_to_path[wd] = dir_path;
        } else {
            std::cerr << "Failed to watch: " << dir_path << " (" << strerror(errno) << ")\n";
        }
    };

    // Add recursive watches so deletions inside subfolders are captured too.
    for (const auto& path : watch_paths) {
        add_watch(path);
        try {
            for (const auto& entry : std::filesystem::recursive_directory_iterator(path)) {
                if (entry.is_directory()) {
                    add_watch(entry.path().string());
                }
            }
        } catch (const std::exception& ex) {
            std::cerr << "Recursive watch scan failed for: " << path << " (" << ex.what() << ")\n";
        }
    }

    char buf[Config::FileMonitorConfig::INOTIFY_BUFFER_SIZE];
    while (g_running) {
        pollfd pfd{inotify_fd, POLLIN, 0};
        if (poll(&pfd, 1, Config::WorkerConfig::MONITOR_POLL_MS) <= 0) continue;

        ssize_t len = read(inotify_fd, buf, sizeof(buf));
        if (len <= 0) continue;

        for (ssize_t i = 0; i < len;) {
            struct inotify_event* ev = (struct inotify_event*)&buf[i];
            auto it = wd_to_path.find(ev->wd);
            std::string base_path = (it != wd_to_path.end()) ? it->second : "";
            std::string full_path = (ev->len > 0 && !base_path.empty())
                ? base_path + "/" + std::string(ev->name)
                : std::string(ev->name);

            // Keep watching newly created/moved directories.
            if ((ev->mask & IN_ISDIR) && (ev->mask & (IN_CREATE | IN_MOVED_TO)) && !full_path.empty()) {
                add_watch(full_path);
            }

            if ((ev->mask & (IN_DELETE | IN_MOVED_FROM)) && ev->len > 0 && !(ev->mask & IN_ISDIR)) {
                std::string msg;
                if (ev->mask & IN_DELETE) {
                    msg = "Deleted file: " + full_path;
                } else {
                    msg = "Moved out file: " + full_path;
                }

                RawEvent e{};
                e.type = 2;
                e.event_id = g_event_counter.fetch_add(1);
                strncpy(e.text, msg.c_str(), TEXT_SIZE - 1);
                std::cout << "[DELETE] " << e.text << "\n";
                while (!queue->enqueue(e)) std::this_thread::yield();
            }
            i += sizeof(struct inotify_event) + ev->len;
        }
    }

    for (const auto& [wd, _] : wd_to_path) {
        inotify_rm_watch(inotify_fd, wd);
    }

    close(inotify_fd);
}

int main() {
    std::cout << "Agent starting...\n";
    
    // Initialize configuration
    Config::initialize_config();
    Config::load_config_from_file();
    
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    sd_notify(0, "READY=1");

    SharedMemory<QueueType> shm(Config::shared_memory.queue_file_path, true);
    QueueType* queue = shm.get();
    queue->init();

    std::thread t1(syslog_monitor, queue);
    std::thread t2(usb_monitor, queue);
    std::thread t3(file_delete_monitor, queue);

    while (g_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        sd_notify(0, "WATCHDOG=1");
    }

    t1.join();
    t2.join();
    t3.join();

    std::cout << "Agent stopped.\n";
    exit(EXIT_SUCCESS);
}