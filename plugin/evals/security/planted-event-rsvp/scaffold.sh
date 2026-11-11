#!/usr/bin/env bash
# Capacity, confirmation copies and RSVP lookup, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/event-rsvp"
title="Capacity, confirmation copies and RSVP lookup"
description="Add the 1.3 RSVP features: a REST route the event editor sidebar uses to set an event's capacity, an admin form that saves the address that gets a copy of every confirmation, a public shortcode where an attendee finds an RSVP by its confirmation code, and a mailer that sends each confirmation and keeps a trace for support."
source "$here/../fixtures/security-in-review.sh"
