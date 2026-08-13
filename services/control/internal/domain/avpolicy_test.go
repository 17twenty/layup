package domain

import "testing"

func TestJoinDefaultsFollowTheParticipantCount(t *testing.T) {
	policy := DefaultPolicy() // threshold 5, camera+mic on
	preference := DefaultMediaPreference()

	for count := 1; count <= 4; count++ {
		got := JoinDefaults(policy, preference, count)
		if !got.Camera || !got.Microphone || got.MutedByThreshold {
			t.Fatalf("participant %d should join with camera and microphone on: %+v", count, got)
		}
	}

	for count := 5; count <= 8; count++ {
		got := JoinDefaults(policy, preference, count)
		if !got.Camera {
			t.Fatalf("participant %d should still join with camera on: %+v", count, got)
		}
		if got.Microphone || !got.MutedByThreshold {
			t.Fatalf("participant %d should join muted, and know why: %+v", count, got)
		}
	}
}

func TestPersonalPreferenceMayOnlyNarrow(t *testing.T) {
	policy := DefaultPolicy()

	// Stricter than policy: honoured.
	strict := JoinDefaults(policy, MediaPreference{CameraOnJoin: false, MicrophoneOnJoin: false}, 2)
	if strict.Camera || strict.Microphone {
		t.Fatalf("a stricter personal preference must win: %+v", strict)
	}

	// More permissive than policy: ignored.
	closed := Policy{CameraOnJoin: false, MicrophoneOnJoin: false, AutoMuteThreshold: 5}
	permissive := JoinDefaults(closed, MediaPreference{CameraOnJoin: true, MicrophoneOnJoin: true}, 2)
	if permissive.Camera || permissive.Microphone {
		t.Fatalf("a preference must not exceed organisation policy: %+v", permissive)
	}
}

func TestOrganisationPolicyCanMoveOrDisableTheThreshold(t *testing.T) {
	preference := DefaultMediaPreference()

	strictOrg := Policy{CameraOnJoin: true, MicrophoneOnJoin: true, AutoMuteThreshold: 3}
	if got := JoinDefaults(strictOrg, preference, 3); got.Microphone || !got.MutedByThreshold {
		t.Fatalf("a threshold of 3 should mute the third participant: %+v", got)
	}
	if got := JoinDefaults(strictOrg, preference, 2); !got.Microphone {
		t.Fatalf("the second participant is below the threshold: %+v", got)
	}

	noThreshold := Policy{CameraOnJoin: true, MicrophoneOnJoin: true, AutoMuteThreshold: 0}
	if got := JoinDefaults(noThreshold, preference, 50); !got.Microphone || got.MutedByThreshold {
		t.Fatalf("a disabled threshold must never auto-mute: %+v", got)
	}
}

func TestJoinDefaultsAreSaneForNonsenseInput(t *testing.T) {
	got := JoinDefaults(DefaultPolicy(), DefaultMediaPreference(), 0)
	if got.ParticipantCount != 1 || !got.Microphone {
		t.Fatalf("a count below one is treated as the first participant: %+v", got)
	}
}
