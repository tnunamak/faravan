//go:build linux

package main

import (
	"context"
	"errors"
	"github.com/godbus/dbus/v5"
)

func inputIdleSeconds(ctx context.Context) (float64, error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return 0, err
	}
	for _, name := range []string{"org.freedesktop.ScreenSaver", "org.kde.screensaver"} {
		var seconds uint32
		err = conn.Object(name, dbus.ObjectPath("/ScreenSaver")).CallWithContext(ctx, "org.freedesktop.ScreenSaver.GetSessionIdleTime", 0).Store(&seconds)
		if err == nil {
			return float64(seconds), nil
		}
	}
	return 0, errors.New("desktop idle time unavailable")
}
