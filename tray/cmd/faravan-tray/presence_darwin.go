//go:build darwin

package main

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
)

func inputIdleSeconds(ctx context.Context) (float64, error) {
	out, err := exec.CommandContext(ctx, "ioreg", "-c", "IOHIDSystem").Output()
	if err != nil {
		return 0, err
	}
	match := regexp.MustCompile(`"HIDIdleTime"\s*=\s*(\d+)`).FindSubmatch(out)
	if len(match) != 2 {
		return 0, errors.New("desktop idle time unavailable")
	}
	nanos, err := strconv.ParseFloat(string(match[1]), 64)
	return nanos / 1e9, err
}
