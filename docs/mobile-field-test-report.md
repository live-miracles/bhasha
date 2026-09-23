# Mobile Field Test Report

Date: 2026-06-21

## Scope

This report tracks real-device listener and translator behavior. Mobile browser behavior is not fully proven by desktop automation. Audio must be tested on physical devices before a real event.

## Test Matrix

| Scenario                                       | Status  | Result       | Blocker                                                                              |
| ---------------------------------------------- | ------- | ------------ | ------------------------------------------------------------------------------------ |
| iPhone Safari listener start/switch/reconnect  | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Android Chrome listener start/switch/reconnect | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| iPhone Safari with Bluetooth audio             | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Android Chrome with Bluetooth audio            | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| iPhone Safari lock screen/background           | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Android Chrome lock screen/background          | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| iPhone Safari low-power mode                   | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Android Chrome battery saver                   | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Mobile data                                    | NOT RUN | Not measured | Requires physical device access and a deployed or locally reachable HTTPS event URL. |
| Venue Wi-Fi                                    | NOT RUN | Not measured | Requires venue network access and a deployed or locally reachable HTTPS event URL.   |

## Required Observations

- Listener audio starts only after a user tap.
- Listener never sees microphone or camera permission prompts.
- Translator sees microphone permission only.
- Translator camera permission is never requested.
- Reconnect controls remain visible after network loss.
- Language switching does not leave stale active listener counts.
- Audio continues or failure is clearly surfaced when the screen locks or the browser backgrounds.
- Bluetooth route changes do not require page reload.
