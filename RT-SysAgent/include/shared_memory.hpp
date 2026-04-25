#pragma once

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdexcept>
#include <cstring>
#include <string>
#include "config.hpp"

template<typename T>
class SharedMemory {
public:
    SharedMemory(const std::string& path, bool create) : fd(-1), data(nullptr), size(sizeof(T)) {
        int flags = create ? (O_CREAT | O_RDWR) : O_RDWR;
        fd = open(path.c_str(), flags, Config::SharedMemoryConfig::FILE_PERMISSIONS);
        if (fd == -1) {
            throw std::runtime_error("Failed to open shared memory file: " + path + " err: " + strerror(errno));
        }

        if (create) {
            // Ensure the queue file is usable by non-root processes (e.g., reader).
            // open(..., mode) can be affected by umask, so enforce permissions explicitly.
            (void)fchmod(fd, Config::SharedMemoryConfig::FILE_PERMISSIONS);
            (void)chmod(path.c_str(), Config::SharedMemoryConfig::FILE_PERMISSIONS);

            if (ftruncate(fd, size) == -1) {
                close(fd);
                throw std::runtime_error("Failed to set size of shared memory file");
            }
        }

        void* addr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (addr == MAP_FAILED) {
            close(fd);
            throw std::runtime_error("mmap failed: " + std::string(strerror(errno)));
        }

        data = static_cast<T*>(addr);
    }

    ~SharedMemory() {
        if (data) {
            munmap(data, size);
            data = nullptr;
        }
        if (fd != -1) {
            close(fd);
            fd = -1;
        }
    }

    T* get() const { return data; }

private:
    int fd;
    T* data;
    size_t size;
};