#include "config.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <unistd.h>
#include <pwd.h>
#include "json.hpp"

using json = nlohmann::json;

namespace Config {
    namespace {
        std::string expand_user_path(const std::string& input) {
            if (input.empty() || input[0] != '~') {
                return input;
            }
            const char* home = std::getenv("HOME");
            if (!home) {
                return input;
            }
            if (input.size() == 1) {
                return std::string(home);
            }
            if (input[1] == '/') {
                return std::string(home) + input.substr(1);
            }
            return input;
        }
    }

    // Global configuration instances
    Directories dirs;
    FileMonitorConfig file_monitor;
    SystemMonitorConfig system_monitor;
    IPFSConfig ipfs;
    EncryptionConfig encryption;
    PatternConfig patterns;
    LoggingConfig logging;
    SharedMemoryConfig shared_memory;

    void initialize_config() {
        // Update paths to be absolute
        encryption.private_key_path = get_absolute_path(encryption.private_key_path);
        encryption.public_key_path = get_absolute_path(encryption.public_key_path);
        patterns.pattern_file_path = get_absolute_path(patterns.pattern_file_path);
        logging.log_file_path = get_absolute_path(logging.log_file_path);
        shared_memory.queue_file_path = get_absolute_path(shared_memory.queue_file_path);
        
        // Create necessary directories
        ensure_directory_exists(dirs.get_keys_path());
        ensure_directory_exists(dirs.get_tmp_path());
        ensure_directory_exists(dirs.get_logs_path());
        ensure_directory_exists(dirs.get_config_path());
        ensure_directory_exists(dirs.get_build_path());
        ensure_directory_exists(dirs.get_bin_path());
    }

    std::string get_project_root() {
        return dirs.project_root;
    }

    std::string get_absolute_path(const std::string& relative_path) {
        const std::string expanded_path = expand_user_path(relative_path);
        if (std::filesystem::path(expanded_path).is_absolute()) {
            return expanded_path;
        }
        return dirs.project_root + "/" + expanded_path;
    }

    bool ensure_directory_exists(const std::string& path) {
        try {
            if (!std::filesystem::exists(path)) {
                return std::filesystem::create_directories(path);
            }
            return true;
        } catch (const std::exception& e) {
            std::cerr << "Error creating directory " << path << ": " << e.what() << std::endl;
            return false;
        }
    }

    std::vector<std::string> get_environment_paths() {
        std::vector<std::string> paths;
        
        // Add common system paths
        paths.push_back("/usr/local/bin");
        paths.push_back("/usr/bin");
        paths.push_back("/bin");
        
        // Add user's home directory
        const char* home = std::getenv("HOME");
        if (home) {
            paths.push_back(std::string(home) + "/.local/bin");
        }
        
        // Add PATH environment variable
        const char* path_env = std::getenv("PATH");
        if (path_env) {
            std::stringstream ss(path_env);
            std::string path;
            while (std::getline(ss, path, ':')) {
                if (!path.empty()) {
                    paths.push_back(path);
                }
            }
        }
        
        return paths;
    }

    void create_default_config() {
        json config;
        
        // Project metadata
        config["project"] = {
            {"name", PROJECT_NAME},
            {"version", VERSION},
            {"debug_mode", DEBUG_MODE},
            {"verbose_logging", VERBOSE_LOGGING}
        };
        
        // Directories
        config["directories"] = {
            {"src_dir", dirs.src_dir},
            {"include_dir", dirs.include_dir},
            {"build_dir", dirs.build_dir},
            {"bin_dir", dirs.bin_dir},
            {"keys_dir", dirs.keys_dir},
            {"tmp_dir", dirs.tmp_dir},
            {"logs_dir", dirs.logs_dir},
            {"config_dir", dirs.config_dir}
        };
        
        // Queue configuration
        config["queue"] = {
            {"size", QueueConfig::DEFAULT_QUEUE_SIZE},
            {"text_size", QueueConfig::DEFAULT_TEXT_SIZE},
            {"cache_line_size", QueueConfig::CACHE_LINE_SIZE},
            {"max_retry_attempts", QueueConfig::MAX_RETRY_ATTEMPTS},
            {"yield_sleep_ms", QueueConfig::YIELD_SLEEP_MS}
        };
        
        // Worker configuration
        config["worker"] = {
            {"num_workers", WorkerConfig::DEFAULT_NUM_WORKERS},
            {"log_threshold", WorkerConfig::LOG_THRESHOLD},
            {"time_threshold_seconds", WorkerConfig::TIME_THRESHOLD_SECONDS},
            {"worker_sleep_ms", WorkerConfig::WORKER_SLEEP_MS},
            {"flusher_sleep_ms", WorkerConfig::FLUSHER_SLEEP_MS},
            {"monitor_poll_ms", WorkerConfig::MONITOR_POLL_MS}
        };
        
        // File monitoring
        config["file_monitor"] = {
            {"watch_paths", file_monitor.watch_paths},
            {"inotify_buffer_size", FileMonitorConfig::INOTIFY_BUFFER_SIZE},
            {"inotify_timeout_ms", FileMonitorConfig::INOTIFY_TIMEOUT_MS}
        };
        
        // System monitoring
        config["system_monitor"] = {
            {"syslog_path", system_monitor.syslog_path},
            {"journald_path", system_monitor.journald_path},
            {"syslog_buffer_size", SystemMonitorConfig::SYSLOG_BUFFER_SIZE},
            {"usb_poll_timeout_ms", SystemMonitorConfig::USB_POLL_TIMEOUT_MS}
        };
        
        // IPFS configuration
        config["ipfs"] = {
            {"ipns_key_name", ipfs.ipns_key_name},
            {"daemon_url", ipfs.ipfs_daemon_url},
            {"timeout_seconds", IPFSConfig::IPFS_TIMEOUT_SECONDS},
            {"ipns_ttl_seconds", IPFSConfig::IPNS_TTL_SECONDS},
            {"allow_offline", IPFSConfig::ALLOW_OFFLINE}
        };
        
        // Encryption configuration
        config["encryption"] = {
            {"private_key_path", encryption.private_key_path},
            {"public_key_path", encryption.public_key_path},
            {"rsa_key_size", EncryptionConfig::RSA_KEY_SIZE},
            {"aes_key_size", EncryptionConfig::AES_KEY_SIZE},
            {"aes_iv_size", EncryptionConfig::AES_IV_SIZE},
            {"aes_tag_size", EncryptionConfig::AES_TAG_SIZE}
        };
        
        // Pattern configuration
        config["patterns"] = {
            {"pattern_file_path", patterns.pattern_file_path},
            {"default_patterns", patterns.default_patterns}
        };
        
        // Logging configuration
        config["logging"] = {
            {"log_file_path", logging.log_file_path},
            {"enable_console_logging", LoggingConfig::ENABLE_CONSOLE_LOGGING},
            {"enable_file_logging", LoggingConfig::ENABLE_FILE_LOGGING},
            {"max_log_file_size_mb", LoggingConfig::MAX_LOG_FILE_SIZE_MB},
            {"max_log_files", LoggingConfig::MAX_LOG_FILES}
        };
        
        // Shared memory configuration
        config["shared_memory"] = {
            {"queue_file_path", shared_memory.queue_file_path},
            {"file_permissions", SharedMemoryConfig::FILE_PERMISSIONS},
            {"create_if_not_exists", SharedMemoryConfig::CREATE_IF_NOT_EXISTS}
        };
        
        // Systemd configuration
        config["systemd"] = {
            {"enable_integration", SystemdConfig::ENABLE_SYSTEMD_INTEGRATION},
            {"watchdog_timeout_ms", SystemdConfig::WATCHDOG_TIMEOUT_MS},
            {"service_name", SystemdConfig::SERVICE_NAME},
            {"service_description", SystemdConfig::SERVICE_DESCRIPTION}
        };
        
        // Save to file
        std::string config_file = dirs.get_config_path() + "/settings.json";
        std::ofstream file(config_file);
        if (file.is_open()) {
            file << config.dump(2);
            std::cout << "Default configuration created: " << config_file << std::endl;
        } else {
            std::cerr << "Failed to create configuration file: " << config_file << std::endl;
        }
    }

    void load_config_from_file(const std::string& config_file) {
        std::string full_path = get_absolute_path(config_file);
        std::ifstream file(full_path);
        
        if (!file.is_open()) {
            std::cout << "Configuration file not found: " << full_path << std::endl;
            std::cout << "Creating default configuration..." << std::endl;
            create_default_config();
            return;
        }
        
        try {
            json config;
            file >> config;
            
            // Load configuration values
            if (config.contains("directories")) {
                auto& dir_config = config["directories"];
                if (dir_config.contains("src_dir")) dirs.src_dir = dir_config["src_dir"];
                if (dir_config.contains("include_dir")) dirs.include_dir = dir_config["include_dir"];
                if (dir_config.contains("build_dir")) dirs.build_dir = dir_config["build_dir"];
                if (dir_config.contains("bin_dir")) dirs.bin_dir = dir_config["bin_dir"];
                if (dir_config.contains("keys_dir")) dirs.keys_dir = dir_config["keys_dir"];
                if (dir_config.contains("tmp_dir")) dirs.tmp_dir = dir_config["tmp_dir"];
                if (dir_config.contains("logs_dir")) dirs.logs_dir = dir_config["logs_dir"];
                if (dir_config.contains("config_dir")) dirs.config_dir = dir_config["config_dir"];
            }
            
            if (config.contains("file_monitor") && config["file_monitor"].contains("watch_paths")) {
                file_monitor.watch_paths = config["file_monitor"]["watch_paths"].get<std::vector<std::string>>();
                for (auto& path : file_monitor.watch_paths) {
                    path = get_absolute_path(path);
                }
            }
            
            if (config.contains("system_monitor")) {
                auto& sys_config = config["system_monitor"];
                if (sys_config.contains("syslog_path")) system_monitor.syslog_path = sys_config["syslog_path"];
                if (sys_config.contains("journald_path")) system_monitor.journald_path = sys_config["journald_path"];
            }
            
            if (config.contains("ipfs")) {
                auto& ipfs_config = config["ipfs"];
                if (ipfs_config.contains("ipns_key_name")) ipfs.ipns_key_name = ipfs_config["ipns_key_name"];
                if (ipfs_config.contains("daemon_url")) ipfs.ipfs_daemon_url = ipfs_config["daemon_url"];
            }
            
            if (config.contains("encryption")) {
                auto& enc_config = config["encryption"];
                if (enc_config.contains("private_key_path")) encryption.private_key_path = enc_config["private_key_path"];
                if (enc_config.contains("public_key_path")) encryption.public_key_path = enc_config["public_key_path"];
                encryption.private_key_path = get_absolute_path(encryption.private_key_path);
                encryption.public_key_path = get_absolute_path(encryption.public_key_path);
            }
            
            if (config.contains("patterns")) {
                auto& pat_config = config["patterns"];
                if (pat_config.contains("pattern_file_path")) patterns.pattern_file_path = pat_config["pattern_file_path"];
                if (pat_config.contains("default_patterns")) {
                    patterns.default_patterns = pat_config["default_patterns"].get<std::vector<std::string>>();
                }
                patterns.pattern_file_path = get_absolute_path(patterns.pattern_file_path);
            }
            
            if (config.contains("logging")) {
                auto& log_config = config["logging"];
                if (log_config.contains("log_file_path")) logging.log_file_path = log_config["log_file_path"];
                logging.log_file_path = get_absolute_path(logging.log_file_path);
            }
            
            if (config.contains("shared_memory")) {
                auto& shm_config = config["shared_memory"];
                if (shm_config.contains("queue_file_path")) shared_memory.queue_file_path = shm_config["queue_file_path"];
                shared_memory.queue_file_path = get_absolute_path(shared_memory.queue_file_path);
            }
            
            std::cout << "Configuration loaded from: " << full_path << std::endl;
            
        } catch (const std::exception& e) {
            std::cerr << "Error loading configuration: " << e.what() << std::endl;
            std::cout << "Using default configuration..." << std::endl;
        }
    }

    void save_config_to_file(const std::string& config_file [[maybe_unused]]) {
        create_default_config(); // This will save the current configuration
    }

    bool validate_config() {
        bool valid = true;
        
        // Check required directories
        if (!check_required_directories()) {
            valid = false;
        }
        
        // Check system dependencies
        if (!check_system_dependencies()) {
            valid = false;
        }
        
        // Check IPFS installation
        if (!check_ipfs_installation()) {
            valid = false;
        }
        
        return valid;
    }

    bool check_required_files() {
        bool all_exist = true;
        
        // Check if pattern file exists, create if not
        if (!std::filesystem::exists(patterns.pattern_file_path)) {
            std::cout << "Creating default pattern file: " << patterns.pattern_file_path << std::endl;
            std::ofstream file(patterns.pattern_file_path);
            if (file.is_open()) {
                for (const auto& pattern : patterns.default_patterns) {
                    file << pattern << std::endl;
                }
            } else {
                std::cerr << "Failed to create pattern file: " << patterns.pattern_file_path << std::endl;
                all_exist = false;
            }
        }
        
        return all_exist;
    }

    bool check_required_directories() {
        bool all_exist = true;
        
        std::vector<std::string> required_dirs = {
            dirs.get_src_path(),
            dirs.get_include_path(),
            dirs.get_keys_path(),
            dirs.get_tmp_path(),
            dirs.get_logs_path(),
            dirs.get_config_path()
        };
        
        for (const auto& dir : required_dirs) {
            if (!ensure_directory_exists(dir)) {
                std::cerr << "Failed to create required directory: " << dir << std::endl;
                all_exist = false;
            }
        }
        
        return all_exist;
    }

    bool check_ipfs_installation() {
        // Check if IPFS is in PATH
        FILE* pipe = popen("which ipfs", "r");
        if (!pipe) {
            std::cerr << "Failed to check IPFS installation" << std::endl;
            return false;
        }
        
        char buffer[128];
        std::string result;
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result += buffer;
        }
        pclose(pipe);
        
        if (result.empty()) {
            std::cout << "IPFS not found in PATH. Please install IPFS first." << std::endl;
            return false;
        }
        
        // Check if IPFS daemon is running
        pipe = popen("pgrep -x ipfs", "r");
        if (!pipe) {
            std::cerr << "Failed to check IPFS daemon" << std::endl;
            return false;
        }
        
        result.clear();
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result += buffer;
        }
        pclose(pipe);
        
        if (result.empty()) {
            std::cout << "IPFS daemon is not running. Please start it with: ipfs daemon" << std::endl;
            return false;
        }
        
        return true;
    }

    bool check_system_dependencies() {
        bool all_available = true;
        
        // Check for required libraries
        std::vector<std::string> required_libs = {
            "libudev",
            "libsystemd",
            "libssl"
        };
        
        for (const auto& lib : required_libs) {
            std::string cmd = "pkg-config --exists " + lib;
            if (system(cmd.c_str()) != 0) {
                std::cerr << "Required library not found: " << lib << std::endl;
                all_available = false;
            }
        }
        
        // Check for required headers
        std::vector<std::string> required_headers = {
            "sys/inotify.h",
            "sys/mman.h",
            "unistd.h"
        };
        
        for (const auto& header : required_headers) {
            std::string cmd = "echo '#include <" + header + ">' | g++ -E - > /dev/null 2>&1";
            if (system(cmd.c_str()) != 0) {
                std::cerr << "Required header not found: " << header << std::endl;
                all_available = false;
            }
        }
        
        return all_available;
    }
} 