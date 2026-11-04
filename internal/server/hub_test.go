package server

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

func decode(t *testing.T, e event) Ev {
	t.Helper()
	var ev Ev
	if err := json.Unmarshal(e.data, &ev); err != nil {
		t.Fatal(err)
	}
	return ev
}

func TestHubReplay(t *testing.T) {
	h := newHub()
	for i := 1; i <= 3; i++ {
		h.publish(Ev{Type: "sessions", Text: fmt.Sprint(i)})
	}
	// A fresh viewer gets a snapshot at the current id, then live events.
	s, replay, snap := h.subscribe("")
	if snap == nil || replay != nil || snap.id != h.epoch+"-3" || decode(t, *snap).Gap {
		t.Fatalf("fresh: snap %+v replay %d", snap, len(replay))
	}
	h.publish(Ev{Type: "sessions", Text: "4"})
	if e := <-s.ch; e.id != h.epoch+"-4" {
		t.Errorf("live event id %s", e.id)
	}
	// A viewer that saw event 1 gets 2, 3 and 4 replayed.
	_, replay, snap = h.subscribe(h.epoch + "-1")
	if snap != nil || len(replay) != 3 || decode(t, replay[0]).Text != "2" || decode(t, replay[2]).Text != "4" {
		t.Errorf("replay from 1: snap %v, %d events", snap != nil, len(replay))
	}
	// Up to date: nothing to replay, no snapshot.
	if _, replay, snap = h.subscribe(h.epoch + "-4"); snap != nil || len(replay) != 0 {
		t.Errorf("up to date: snap %v, %d events", snap != nil, len(replay))
	}
	// An id from an earlier server run, or from the future, is a gap.
	for _, id := range []string{"old-2", h.epoch + "-99", "junk"} {
		if _, _, snap = h.subscribe(id); snap == nil || !decode(t, *snap).Gap {
			t.Errorf("%s: want a gap snapshot", id)
		}
	}
}

func TestHubRingAndSlowViewer(t *testing.T) {
	h := newHub()
	slow, _, _ := h.subscribe("")
	for i := 0; i < 2*ringSize+10; i++ {
		h.publish(Ev{Type: "delta"})
	}
	// The slow viewer never read; it was cut off once its queue filled.
	n := 0
	for range slow.ch {
		n++
	}
	if n != subQueue {
		t.Errorf("slow viewer got %d events before being cut off, want %d", n, subQueue)
	}
	h.unsubscribe(slow) // already gone; must not panic
	if _, _, snap := h.subscribe(h.epoch + "-1"); snap == nil || !decode(t, *snap).Gap {
		t.Error("an id that fell out of the ring should get a gap snapshot")
	}
	if len(h.ring) < ringSize {
		t.Errorf("ring holds %d", len(h.ring))
	}
	last := fmt.Sprintf("%s-%d", h.epoch, h.seq-ringSize)
	if _, replay, snap := h.subscribe(last); snap != nil || len(replay) != ringSize {
		t.Errorf("replay of the last %d: snap %v, %d events", ringSize, snap != nil, len(replay))
	}
}

// Viewers subscribing while events are published concurrently each see an
// unbroken run of sequence numbers after their snapshot or replay point:
// no hole, no duplicate.
func TestHubConcurrent(t *testing.T) {
	h := newHub()
	const publishers, perPublisher, viewers = 4, 3000, 16
	var wg sync.WaitGroup
	for p := 0; p < publishers; p++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perPublisher; i++ {
				h.publish(Ev{Type: "delta", Session: "a", Text: "x"})
			}
		}()
	}
	errs := make(chan error, viewers)
	for v := 0; v < viewers; v++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(time.Duration(v) * time.Millisecond)
			last := ""
			if v%2 == 1 { // half resume from a recent id
				h.mu.Lock()
				if h.seq > 5 {
					last = fmt.Sprintf("%s-%d", h.epoch, h.seq-5)
				}
				h.mu.Unlock()
			}
			s, replay, snap := h.subscribe(last)
			defer h.unsubscribe(s)
			var want uint64
			if snap != nil {
				want = snap.seq + 1
			} else {
				want, _ = h.parseID(last)
				want++
			}
			check := func(e event) bool {
				if e.seq != want {
					errs <- fmt.Errorf("viewer %d: got seq %d, want %d", v, e.seq, want)
					return false
				}
				want++
				return true
			}
			for _, e := range replay {
				if !check(e) {
					return
				}
			}
			timeout := time.After(10 * time.Second)
			for want <= publishers*perPublisher {
				select {
				case e, ok := <-s.ch:
					if !ok {
						return // cut off as too slow; what it got was in order
					}
					if !check(e) {
						return
					}
				case <-timeout:
					errs <- fmt.Errorf("viewer %d: stuck waiting for seq %d", v, want)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestHubLiveState(t *testing.T) {
	h := newHub()
	h.publish(Ev{Type: "turn", Session: "a", PromptID: "p1", State: "starting"})
	h.publish(Ev{Type: "turn", Session: "a", State: "running"})
	h.publish(Ev{Type: "delta", Session: "a", Index: 1, Kind: "text", Text: "Hel"})
	h.publish(Ev{Type: "delta", Session: "a", Index: 1, Kind: "text", Text: "lo"})
	h.publish(Ev{Type: "permission", Session: "a", Permission: &Permission{ID: "r1", Tool: "Bash"}})
	h.publish(Ev{Type: "permission", Session: "a", Permission: &Permission{ID: "r2", Tool: "Edit"}})
	h.publish(Ev{Type: "permissionDone", Session: "a", RequestID: "r1", Decision: "allow"})

	_, _, snap := h.subscribe("")
	ev := decode(t, *snap)
	if len(ev.Turns) != 1 {
		t.Fatalf("turns: %+v", ev.Turns)
	}
	lt := ev.Turns[0]
	if lt.Session != "a" || lt.PromptID != "p1" || lt.State != "running" || lt.Blocks[1] == nil || lt.Blocks[1].Text != "Hello" {
		t.Errorf("live turn: %+v", lt)
	}
	if len(lt.Permissions) != 1 || lt.Permissions[0].ID != "r2" {
		t.Errorf("pending permissions: %+v", lt.Permissions)
	}

	h.publish(Ev{Type: "appended", Session: "a", Kind: "assistant", UUID: "x"})
	if _, _, snap = h.subscribe(""); len(decode(t, *snap).Turns[0].Blocks) != 0 {
		t.Error("a complete assistant row should clear the partial blocks")
	}
	h.publish(Ev{Type: "turn", Session: "a", State: "done", Result: &Result{OK: true}})
	if _, _, snap = h.subscribe(""); len(decode(t, *snap).Turns) != 0 {
		t.Error("a finished turn should leave the live state")
	}
}
