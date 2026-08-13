# ADR-0008 - Split WebRTC data semantics

Status: Accepted for PLAN-1

Cursor motion is unordered/loss-tolerant/latest-wins. Input actions are ordered/reliable. Drawing is separate and may be loss-tolerant where appropriate. Do not create reliable queues for stale cursor motion.
