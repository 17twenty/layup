package domain

// Join defaults for camera and microphone (SPEC.md §4).
//
//	resulting participant count 1-4:  camera ON,  microphone ON
//	participant 5 or later:           camera ON,  microphone MUTED
//
// PLAN-1 is 1:1, but the threshold lives in the domain now so it is not bolted
// on later (PLAN-1.md, Phase D).
//
// Precedence is organisation policy -> personal preference -> layup setting ->
// presenter safety override (SPEC.md §15). Each step may only narrow what the
// previous one allowed: a personal preference can mute you when policy would
// have unmuted you, never the other way round.

// MediaPreference is what one person wants, independently of any layup.
type MediaPreference struct {
	// CameraOnJoin and MicrophoneOnJoin are stricter-only: false means "never
	// start this device on", true means "follow the organisation policy".
	CameraOnJoin     bool
	MicrophoneOnJoin bool
}

// DefaultMediaPreference follows organisation policy in both directions.
func DefaultMediaPreference() MediaPreference {
	return MediaPreference{CameraOnJoin: true, MicrophoneOnJoin: true}
}

// JoinMediaDefaults is what a client should do when media starts.
type JoinMediaDefaults struct {
	Camera     bool `json:"camera"`
	Microphone bool `json:"microphone"`
	// ParticipantCount is the resulting count this decision was made for.
	ParticipantCount int `json:"participantCount"`
	// MutedByThreshold records that the auto-mute rule applied, so the UI can
	// explain why the person is muted rather than looking broken.
	MutedByThreshold bool `json:"mutedByThreshold"`
}

// JoinDefaults applies the policy for someone joining a layup that will have
// participantCount participants once they are in.
func JoinDefaults(policy Policy, preference MediaPreference, participantCount int) JoinMediaDefaults {
	if participantCount < 1 {
		participantCount = 1
	}

	camera := policy.CameraOnJoin
	microphone := policy.MicrophoneOnJoin

	// The auto-mute threshold: joining as participant 5 or later starts muted.
	mutedByThreshold := false
	if policy.AutoMuteThreshold > 0 && participantCount >= policy.AutoMuteThreshold && microphone {
		microphone = false
		mutedByThreshold = true
	}

	// Personal preference may only narrow.
	if !preference.CameraOnJoin {
		camera = false
	}
	if !preference.MicrophoneOnJoin {
		microphone = false
	}

	return JoinMediaDefaults{
		Camera:           camera,
		Microphone:       microphone,
		ParticipantCount: participantCount,
		MutedByThreshold: mutedByThreshold,
	}
}
