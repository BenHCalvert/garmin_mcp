# Garmin Connect MCP Server

Exposes your Garmin Connect data — activities, health metrics, training readiness, and more — as MCP tools for use with Claude and other MCP clients.

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Set credentials

```bash
export GARMIN_EMAIL=you@example.com
export GARMIN_PASSWORD=yourpassword
```

Tokens are cached at `~/.garmin_tokens/<email>.pkl` after first login so you don't re-authenticate every session. To override the token directory:

```bash
export GARMIN_TOKEN_STORE=/path/to/token/dir
```

If your account has MFA enabled, you'll be prompted for the OTP on first run.

### 3. Run the server

```bash
python server.py
```

Or with the MCP inspector for testing:

```bash
npx @modelcontextprotocol/inspector python server.py
```

## Claude Desktop / Claude Code config

Add to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "python",
      "args": ["/path/to/garmin_mcp/server.py"],
      "env": {
        "GARMIN_EMAIL": "you@example.com",
        "GARMIN_PASSWORD": "yourpassword"
      }
    }
  }
}
```

## Available Tools

### Health & Recovery
| Tool | Description |
|------|-------------|
| `garmin_get_stats` | Daily summary: steps, calories, active minutes, stress |
| `garmin_get_sleep` | Sleep stages, duration, sleep score |
| `garmin_get_body_battery` | Body Battery levels over a date range |
| `garmin_get_hrv` | Heart Rate Variability — key recovery metric |
| `garmin_get_heart_rate` | Resting HR and intraday readings |
| `garmin_get_stress` | Stress levels throughout the day |
| `garmin_get_spo2` | Blood oxygen (SpO2) — useful post-altitude |
| `garmin_get_respiration` | Respiration rate data |
| `garmin_get_training_readiness` | Readiness score combining HRV, sleep, load |

### Activities
| Tool | Description |
|------|-------------|
| `garmin_list_activities` | List recent activities, filterable by type |
| `garmin_get_last_activity` | Most recent activity |
| `garmin_get_activity` | Full details for a specific activity ID |
| `garmin_get_activity_splits` | Lap/split data for an activity |
| `garmin_get_activities_by_date` | Activities within a date range |

### Fitness & Performance
| Tool | Description |
|------|-------------|
| `garmin_get_training_status` | VO2max, training load, recovery time |
| `garmin_get_max_metrics` | VO2 max estimates |
| `garmin_get_personal_records` | All-time PRs across activity types |
| `garmin_get_endurance_score` | Aerobic fitness trend |
| `garmin_get_race_predictions` | Predicted 5K / 10K / half / marathon times |
| `garmin_get_steps` | Daily step counts over a range |
| `garmin_get_weekly_steps` | Weekly step summary |

### Account & Devices
| Tool | Description |
|------|-------------|
| `garmin_get_user_profile` | Account profile info |
| `garmin_get_devices` | Connected Garmin devices |

## Activity Type Filter Examples

Use `garmin_list_activities` with `activity_type` set to:
- `backcountry_skiing` — ski tours
- `resort_skiing` — resort days
- `cycling` / `mountain_biking`
- `running` / `trail_running`
- `hiking`

## Notes

- Uses the unofficial `garminconnect` Python library by cyberjunky
- The Garmin Connect API is not officially published; Garmin may change it
- Rate limiting: Garmin may throttle heavy API usage
