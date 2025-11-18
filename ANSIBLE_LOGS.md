# Pulling House Lights Logs with Ansible (Using journalctl)

## Service Name
The default service name is `houselights`. If you've customized it, set the `HOUSE_LIGHTS_SYSTEMD_SERVICE` environment variable or replace `houselights` in the commands below.

## Quick Commands

### View Last N Lines of Logs
```bash
# View last 100 lines
ansible all -a "journalctl -u houselights -n 100 --no-pager"

# View last 500 lines (for debugging)
ansible all -a "journalctl -u houselights -n 500 --no-pager"

# View last 1000 lines
ansible all -a "journalctl -u houselights -n 1000 --no-pager"
```

### Follow Logs in Real-Time
```bash
# Note: This will run until interrupted (Ctrl+C)
ansible all -a "journalctl -u houselights -f"
```

### View Logs Since Specific Time
```bash
# Last 10 minutes
ansible all -a "journalctl -u houselights --since '10 minutes ago' --no-pager"

# Last hour
ansible all -a "journalctl -u houselights --since '1 hour ago' --no-pager"

# Since today
ansible all -a "journalctl -u houselights --since today --no-pager"

# Since specific date/time
ansible all -a "journalctl -u houselights --since '2024-01-15 10:00:00' --no-pager"
```

### Search Logs for Specific Terms
```bash
# Search for live mode entries (last 500 lines)
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -i 'live'"

# Search for WebSocket commands
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -iE 'live_frame|live_play|live_pause|websocket'"

# Search for errors and warnings
ansible all -a "journalctl -u houselights -n 1000 --no-pager | grep -iE 'error|exception|warning'"

# Search for specific scene_id
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep 'scene_id'"
```

### Export Logs to File
```bash
# Save last 1000 lines to local file
ansible all -a "journalctl -u houselights -n 1000 --no-pager" > logs/{{ inventory_hostname }}-$(date +%Y%m%d-%H%M%S).log

# Or use Ansible fetch module (if you save remotely first)
ansible all -a "journalctl -u houselights -n 1000 --no-pager > /tmp/houselights-logs.txt"
ansible all -m fetch -a "src=/tmp/houselights-logs.txt dest=./logs/{{ inventory_hostname }}-logs.txt flat=yes"
```

### Get Service Status
```bash
# Check if service is running
ansible all -a "systemctl status houselights"

# Check service status (brief)
ansible all -a "systemctl is-active houselights"

# Check service enabled status
ansible all -a "systemctl is-enabled houselights"
```

### View Logs with Timestamps
```bash
# ISO timestamps (more readable)
ansible all -a "journalctl -u houselights -n 100 --no-pager -o short-iso"

# Full timestamps
ansible all -a "journalctl -u houselights -n 100 --no-pager -o short-precise"
```

## Using Ansible Playbook

Create a playbook `pull_logs.yml`:

```yaml
---
- name: Pull House Lights Logs via journalctl
  hosts: all
  gather_facts: yes
  vars:
    service_name: "{{ lookup('env', 'HOUSE_LIGHTS_SYSTEMD_SERVICE') | default('houselights', true) }}"
  tasks:
    - name: Check if service exists
      systemd:
        name: "{{ service_name }}"
      register: service_status

    - name: Get last 500 lines of logs
      command: journalctl -u {{ service_name }} -n 500 --no-pager -o short-iso
      register: log_output
      when: service_status.status.ActiveState == "active"

    - name: Save logs to local file
      copy:
        content: "{{ log_output.stdout }}"
        dest: "./logs/{{ inventory_hostname }}-{{ ansible_date_time.epoch }}.log"
      when: service_status.status.ActiveState == "active"

    - name: Display log summary
      debug:
        msg: "{{ log_output.stdout_lines[-20:] }}"
      when: service_status.status.ActiveState == "active"

    - name: Service not running
      debug:
        msg: "Service {{ service_name }} is not active on {{ inventory_hostname }}"
      when: service_status.status.ActiveState != "active"
```

Run with:
```bash
ansible-playbook pull_logs.yml
```

## Most Useful for Live Mode Debugging

```bash
# Get recent live mode activity (last 500 lines filtered for live mode)
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -i 'live'"

# Get WebSocket command results
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -E 'live_frame|live_play|live_pause|WebSocket'"

# Get all errors and warnings from last 1000 lines
ansible all -a "journalctl -u houselights -n 1000 --no-pager | grep -E 'ERROR|WARNING|Exception'"

# Get playback start/stop events
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -E 'Playback (start|stop)'"

# Get keyframe application events
ansible all -a "journalctl -u houselights -n 500 --no-pager | grep -E 'Applying keyframe'"

# Follow logs in real-time while testing
ansible all -a "journalctl -u houselights -f --since '1 minute ago'"
```

## Custom Service Name

If your service has a different name, replace `houselights` in the commands:

```bash
# Example with custom service name
ansible all -a "journalctl -u houselights-controller -n 100 --no-pager"

# Or use environment variable
ansible all -a "journalctl -u ${HOUSE_LIGHTS_SYSTEMD_SERVICE:-houselights} -n 100 --no-pager"
```

## Notes

- Replace `all` with your specific host/group name from your inventory
- If using a custom inventory file: add `-i inventory.ini`
- If using SSH keys: make sure they're configured
- Default service name is `houselights` (configurable via `HOUSE_LIGHTS_SYSTEMD_SERVICE` env var)
- journalctl requires appropriate permissions (usually needs to be run as root or user with journal access)
- If journalctl is not available, the application falls back to file-based logging

