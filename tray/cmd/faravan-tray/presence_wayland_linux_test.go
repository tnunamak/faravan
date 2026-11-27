//go:build linux

package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

func TestWaylandIdleEvidenceFollowsCompositor(t *testing.T) {
	t.Run("version 1", func(t *testing.T) { testWaylandIdleEvidence(t, 1, 1) })
	t.Run("version 2", func(t *testing.T) { testWaylandIdleEvidence(t, 2, 2) })
}

func testWaylandIdleEvidence(t *testing.T, version uint32, notificationOpcode uint16) {
	socket := fmt.Sprintf("@faravan-wayland-test-%d-%d", os.Getpid(), time.Now().UnixNano())
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_ = listener.SetDeadline(time.Now().Add(5 * time.Second))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	evidence := make(chan idleEvidence, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchWaylandIdle(ctx, socket, ownerAwayAfter, func(value idleEvidence) { evidence <- value })
	}()
	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	expect := func(want idleEvidence) {
		t.Helper()
		select {
		case got := <-evidence:
			if got != want {
				t.Fatalf("evidence = %d, want %d", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no evidence %d", want)
		}
	}
	expect(idleUnknown)
	request := func(wantObject uint32, wantOpcode uint16) []byte {
		t.Helper()
		var header [8]byte
		if _, err := io.ReadFull(conn, header[:]); err != nil {
			t.Fatal(err)
		}
		object := binary.NativeEndian.Uint32(header[:])
		kind := binary.NativeEndian.Uint32(header[4:])
		if object != wantObject || uint16(kind) != wantOpcode || kind>>16 < 8 {
			t.Fatalf("unexpected request object %d and header %#x", object, kind)
		}
		body := make([]byte, (kind>>16)-8)
		if _, err := io.ReadFull(conn, body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	event := func(object, opcode uint32, body []byte) {
		t.Helper()
		data := binary.NativeEndian.AppendUint32(nil, object)
		data = binary.NativeEndian.AppendUint32(data, uint32(len(body)+8)<<16|opcode)
		if _, err := conn.Write(append(data, body...)); err != nil {
			t.Fatal(err)
		}
	}
	registry := binary.NativeEndian.Uint32(request(1, 1))
	callback := binary.NativeEndian.Uint32(request(1, 0))
	global := func(name uint32, iface string, version uint32) {
		body := binary.NativeEndian.AppendUint32(nil, name)
		body = binary.NativeEndian.AppendUint32(body, uint32(len(iface)+1))
		body = append(body, iface...)
		body = append(body, make([]byte, 4-len(iface)%4)...)
		event(registry, 0, binary.NativeEndian.AppendUint32(body, version))
	}
	global(20, "ext_idle_notifier_v1", version)
	global(21, "wl_seat", 9)
	event(callback, 0, make([]byte, 4))

	binding := request(registry, 0)
	if got := binary.NativeEndian.Uint32(binding[len(binding)-8:]); got != version {
		t.Fatalf("bound notifier version = %d, want %d", got, version)
	}
	notifier := binary.NativeEndian.Uint32(binding[len(binding)-4:])
	seatBinding := request(registry, 0)
	seat := binary.NativeEndian.Uint32(seatBinding[len(seatBinding)-4:])
	notify := request(notifier, notificationOpcode)
	notification := binary.NativeEndian.Uint32(notify)
	if wait := binary.NativeEndian.Uint32(notify[4:]); wait != 300000 {
		t.Fatalf("idle timeout = %d ms", wait)
	}
	if object := binary.NativeEndian.Uint32(notify[8:]); object != seat {
		t.Fatalf("idle notification bound to object %d, want seat %d", object, seat)
	}
	select {
	case got := <-evidence:
		t.Fatalf("evidence %d without a compositor event", got)
	default:
	}
	event(notification, 0, nil)
	expect(idleAway)
	event(notification, 1, nil)
	expect(idleActive)
	event(notification, 0, nil)
	expect(idleAway)
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	expect(idleUnknown)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not exit after disconnect")
	}
}
