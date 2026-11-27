//go:build windows

package main

import (
	"context"
	"errors"
	"syscall"
	"unsafe"
)

func init() {
	windowsTrayAppearance = currentWindowsTrayAppearance
}

// Read the system theme, not AppsUseLightTheme: Windows supports a light app
// theme with a dark taskbar. Re-read on each refresh, including unchanged menus.
func currentWindowsTrayAppearance() (light bool, size int) {
	size = 16
	metric, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("GetSystemMetrics").Call(49) // SM_CXSMICON
	if metric >= 16 && metric <= 256 {
		size = int(metric)
	}
	path, _ := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`)
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, path, 0, syscall.KEY_QUERY_VALUE, &key); err != nil {
		return false, size // Older Windows and unavailable settings use the dark-taskbar fallback.
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString("SystemUsesLightTheme")
	var value, kind uint32
	length := uint32(unsafe.Sizeof(value))
	err := syscall.RegQueryValueEx(key, name, nil, &kind, (*byte)(unsafe.Pointer(&value)), &length)
	return err == nil && kind == syscall.REG_DWORD && length == 4 && value == 1, size
}

func inputIdleSeconds(ctx context.Context) (float64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	var info struct {
		Size uint32
		Tick uint32
	}
	info.Size = uint32(unsafe.Sizeof(info))
	getLastInput := syscall.NewLazyDLL("user32.dll").NewProc("GetLastInputInfo")
	ok, _, _ := getLastInput.Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return 0, errors.New("desktop idle time unavailable")
	}
	tick, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetTickCount").Call()
	return float64(uint32(tick)-info.Tick) / 1000, nil
}
