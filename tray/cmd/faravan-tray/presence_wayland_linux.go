//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/MatthiasKunnen/go-wayland/wayland/client"
	idlenotify "github.com/MatthiasKunnen/go-wayland/wayland/staging/ext-idle-notify-v1"
	"github.com/tnunamak/faravan/tray/internal/faravantray"
)

// Match the owner-presence threshold in lib/v1/lending-presence.mjs.
const ownerAwayAfter = 300 * time.Second

type idleEvidence uint32

const (
	idleUnknown idleEvidence = iota
	idleUnsupported
	idleActive
	idleAway
)

func init() {
	startInputIdle = func(lifetime *faravantray.TrayLifetime) func(context.Context) (float64, error) {
		display := os.Getenv("WAYLAND_DISPLAY")
		if display == "" && os.Getenv("XDG_SESSION_TYPE") != "wayland" {
			return inputIdleSeconds
		}
		if display == "" {
			display = "wayland-0"
		}
		if !filepath.IsAbs(display) {
			runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
			if !filepath.IsAbs(runtimeDir) {
				return inputIdleSeconds
			}
			display = filepath.Join(runtimeDir, display)
		}

		var evidence atomic.Uint32
		lifetime.Go(func(ctx context.Context) {
			for ctx.Err() == nil {
				watchWaylandIdle(ctx, display, ownerAwayAfter, func(value idleEvidence) {
					evidence.Store(uint32(value))
				})
				if idleEvidence(evidence.Load()) == idleUnsupported {
					return
				}
				timer := time.NewTimer(5 * time.Second)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
		})
		return func(ctx context.Context) (float64, error) {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			switch idleEvidence(evidence.Load()) {
			case idleAway:
				return ownerAwayAfter.Seconds(), nil
			case idleActive:
				return 0, nil
			case idleUnsupported:
				return inputIdleSeconds(ctx)
			default:
				return 0, errors.New("Wayland idle time unavailable")
			}
		}
	}
}

func watchWaylandIdle(ctx context.Context, socket string, threshold time.Duration, report func(idleEvidence)) {
	report(idleUnknown)
	display, err := client.Connect(socket)
	if err != nil {
		return
	}
	wayland := display.Context()
	defer wayland.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = wayland.Close() })
	defer stopClose()
	display.SetErrorHandler(func(client.DisplayErrorEvent) {
		report(idleUnknown)
		_ = wayland.Close()
	})

	registry, err := display.GetRegistry()
	if err != nil {
		return
	}
	var notifierName, notifierVersion uint32
	seats := make(map[uint32]bool)
	discovered := false
	registry.SetGlobalHandler(func(event client.RegistryGlobalEvent) {
		switch event.Interface {
		case idlenotify.IdleNotifierInterfaceName:
			if notifierName == 0 && event.Version >= 1 {
				notifierName = event.Name
				notifierVersion = min(event.Version, 2)
			}
		case client.SeatInterfaceName:
			if discovered {
				report(idleUnknown)
				_ = wayland.Close()
			} else if event.Version >= 1 {
				seats[event.Name] = false
			}
		}
	})
	registry.SetGlobalRemoveHandler(func(event client.RegistryGlobalRemoveEvent) {
		_, wasSeat := seats[event.Name]
		if wasSeat || event.Name == notifierName {
			report(idleUnknown)
			_ = wayland.Close()
		}
	})
	if display.Roundtrip() != nil || ctx.Err() != nil {
		return
	}
	if notifierName == 0 {
		report(idleUnsupported)
		return
	}
	if len(seats) == 0 {
		return
	}
	discovered = true
	defer report(idleUnknown)

	notifier := idlenotify.NewIdleNotifier(wayland)
	if registry.Bind(notifierName, idlenotify.IdleNotifierInterfaceName, notifierVersion, notifier) != nil {
		return
	}
	notify := notifier.GetIdleNotification
	if notifierVersion >= 2 {
		// Idle-only lending follows input activity. Power inhibitors can keep
		// the computer awake without anyone using it.
		notify = notifier.GetInputIdleNotification
	}
	for name := range seats {
		seat := client.NewSeat(wayland)
		if registry.Bind(name, client.SeatInterfaceName, 1, seat) != nil {
			return
		}
		notification, err := notify(uint32(threshold.Milliseconds()), seat)
		if err != nil {
			return
		}
		notification.SetIdledHandler(func(idlenotify.IdleNotificationIdledEvent) {
			if seats[name] {
				report(idleUnknown)
				_ = wayland.Close()
				return
			}
			seats[name] = true
			for _, idle := range seats {
				if !idle {
					return
				}
			}
			report(idleAway)
		})
		notification.SetResumedHandler(func(idlenotify.IdleNotificationResumedEvent) {
			if !seats[name] {
				report(idleUnknown)
				_ = wayland.Close()
				return
			}
			seats[name] = false
			report(idleActive)
		})
	}
	for ctx.Err() == nil && wayland.Dispatch() == nil {
	}
}
