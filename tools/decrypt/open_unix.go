//go:build !windows

package main

import "syscall"

// noFollow makes opening a file from the backup fail on a symlink instead of following it, and not block on a FIFO.
const noFollow = syscall.O_NOFOLLOW | syscall.O_NONBLOCK
