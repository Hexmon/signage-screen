# Troubleshooting Guide

## Quick Diagnostics

### Check Service Status
```bash
sudo systemctl status hexmon-player
```

### Check Health Endpoint
```bash
curl http://127.0.0.1:3300/healthz
```

If `/metrics` returns `404`, check whether `observability.metricsEnabled` has been disabled intentionally. If the endpoint is unreachable from another machine, confirm the player is still using the secure default `observability.allowRemoteAccess=false`.

### View Logs
```bash
# Real-time logs
sudo journalctl -u hexmon-player -f

# Last 100 lines
sudo journalctl -u hexmon-player -n 100

# Application logs
sudo tail -f /var/cache/hexmon/logs/hexmon-*.log
```

### Collect Diagnostic Information
```bash
sudo hexmon-collect-logs
```

## Common Issues

### 1. Service Won't Start

**Symptoms:**
- Service fails to start
- Immediate exit after start
- Error in systemd logs

**Diagnosis:**
```bash
sudo systemctl status hexmon-player
sudo journalctl -u hexmon-player -n 50
```

**Common Causes:**

#### Missing Configuration
```bash
# Check if config exists
ls -la /etc/hexmon/config.json

# If missing, copy example
sudo cp /usr/share/hexmon/config.example.json /etc/hexmon/config.json
sudo nano /etc/hexmon/config.json
```

#### Invalid Configuration
```bash
# Validate JSON syntax
cat /etc/hexmon/config.json | jq .

# Check required fields
grep -E '"apiBase"|"wsUrl"|"deviceId"' /etc/hexmon/config.json
```

#### Permission Issues
```bash
# Fix permissions
sudo chown -R hexmon:hexmon /var/lib/hexmon
sudo chown -R hexmon:hexmon /var/cache/hexmon
sudo chmod 700 /var/lib/hexmon/certs
sudo chmod 600 /var/lib/hexmon/certs/*
```

#### Display Not Available
```bash
# Check DISPLAY variable
echo $DISPLAY

# Set DISPLAY in service file
sudo nano /etc/systemd/system/hexmon-player.service
# Add: Environment="DISPLAY=:0"

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart hexmon-player
```

### 2. Device Won't Pair

**Symptoms:**
- Pairing code rejected
- Certificate generation fails
- Network errors during pairing

**Diagnosis:**
```bash
# Check network connectivity
ping -c 3 api.hexmon.com

# Check DNS resolution
nslookup api.hexmon.com

# Test HTTPS connectivity
curl -I https://api.hexmon.com
```

**Solutions:**

#### Network Issues
```bash
# Check firewall
sudo ufw status

# Allow HTTPS
sudo ufw allow 443/tcp

# Check proxy settings
echo $HTTP_PROXY
echo $HTTPS_PROXY
```

#### Certificate Generation Issues
```bash
# Check if openssl is installed
which openssl

# Install if missing
sudo apt-get install openssl

# Manually generate key
sudo openssl ecparam -name prime256v1 -genkey -noout -out /var/lib/hexmon/certs/client.key
sudo chmod 600 /var/lib/hexmon/certs/client.key
```

#### Invalid Pairing Code
- Verify code is exactly 6 characters
- Check for typos (O vs 0, I vs 1)
- Ensure code hasn't expired
- Request new code from admin dashboard

### 3. No Media Playback

**Symptoms:**
- Black screen
- Fallback slide showing
- Media not loading

**Diagnosis:**
```bash
# Check cache status
curl http://127.0.0.1:3300/healthz | jq .cacheUsage

# Check schedule
sudo journalctl -u hexmon-player | grep -i schedule

# Check cache directory
ls -lh /var/cache/hexmon/objects/
```

**Solutions:**

#### Schedule Not Downloaded
```bash
# Check device ID
grep deviceId /etc/hexmon/config.json

# Check API connectivity
curl -I https://api.hexmon.com/v1/device/YOUR_DEVICE_ID/schedule

# Force schedule refresh
# (Restart service)
sudo systemctl restart hexmon-player
```

#### Cache Issues
```bash
# Check disk space
df -h /var/cache/hexmon

# Clear cache
sudo hexmon-clear-cache

# Check cache permissions
ls -la /var/cache/hexmon/
```

#### Media Download Failures
```bash
# Check logs for download errors
sudo journalctl -u hexmon-player | grep -i "download\|cache"

# Check network bandwidth
speedtest-cli

# Verify MinIO/S3 access
# (Check with backend team)
```

### 4. High CPU/Memory Usage

**Symptoms:**
- System sluggish
- High CPU usage
- Memory warnings

**Diagnosis:**
```bash
# Check resource usage
top -p $(pgrep -f hexmon-player)

# Check memory
free -h

# Check CPU
mpstat 1 5
```

**Solutions:**

#### Memory Leak
```bash
# Restart service
sudo systemctl restart hexmon-player

# Monitor memory over time
watch -n 5 'ps aux | grep hexmon-player'

# Check for memory leaks in logs
sudo journalctl -u hexmon-player | grep -i "memory\|heap"
```

#### Too Many Cached Files
```bash
# Check cache size
du -sh /var/cache/hexmon/

# Reduce cache size in config
sudo nano /etc/hexmon/config.json
# Adjust: "maxBytes": 5368709120  (5GB)

# Clear cache
sudo hexmon-clear-cache
```

#### Video Decoding Issues
```bash
# Check video codec support
ffmpeg -codecs | grep h264

# Install hardware acceleration
sudo apt-get install va-driver-all vdpau-driver-all

# Check GPU usage
nvidia-smi  # For NVIDIA
intel_gpu_top  # For Intel
```

### 5. WebSocket Connection Issues

**Symptoms:**
- "Disconnected" status in diagnostics
- No real-time updates
- Frequent reconnections

**Diagnosis:**
```bash
# Check WebSocket status
curl http://127.0.0.1:3300/healthz | jq .

# Check logs
sudo journalctl -u hexmon-player | grep -i websocket

# Test WebSocket connectivity
wscat -c wss://api.hexmon.com/ws
```

**Solutions:**

#### Firewall Blocking WebSocket
```bash
# Allow WebSocket port
sudo ufw allow 443/tcp

# Check if proxy is interfering
unset HTTP_PROXY
unset HTTPS_PROXY
```

#### Certificate Issues
```bash
# Verify certificates
openssl x509 -in /var/lib/hexmon/certs/client.crt -noout -text

# Check expiry
openssl x509 -in /var/lib/hexmon/certs/client.crt -noout -dates

# Renew if expired
sudo hexmon-pair-device
```

### 6. Display Issues

**Symptoms:**
- No display output
- Wrong resolution
- Multiple displays not working

**Diagnosis:**
```bash
# Check display
echo $DISPLAY

# List displays
xrandr --query

# Check X11 access
xhost

# Test display
DISPLAY=:0 xeyes
```

**Solutions:**

#### X11 Permission Issues
```bash
# Grant X11 access to hexmon user
xhost +SI:localuser:hexmon

# Or copy .Xauthority
sudo cp ~/.Xauthority /home/hexmon/
sudo chown hexmon:hexmon /home/hexmon/.Xauthority
```

#### Wrong Display
```bash
# Set correct display in service
sudo nano /etc/systemd/system/hexmon-player.service
# Change: Environment="DISPLAY=:0"

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart hexmon-player
```

#### Resolution Issues
```bash
# Set resolution
xrandr --output HDMI-1 --mode 1920x1080

# Make permanent
sudo nano /etc/X11/xorg.conf.d/10-monitor.conf
```

### 7. Proof-of-Play Not Recording

**Symptoms:**
- No PoP events in backend
- Events not being sent

**Diagnosis:**
```bash
# Check PoP spool directory
ls -la /var/cache/hexmon/pop-spool/

# Check logs
sudo journalctl -u hexmon-player | grep -i "proof-of-play\|pop"
```

**Solutions:**

#### Events Spooled But Not Sent
```bash
# Check network connectivity
curl -I https://api.hexmon.com

# Check device pairing
curl http://127.0.0.1:3300/healthz | jq .deviceId

# Restart to flush queue
sudo systemctl restart hexmon-player
```

## Performance Optimization

### Reduce CPU Usage
```bash
# Limit CPU quota in service file
sudo nano /etc/systemd/system/hexmon-player.service
# Add: CPUQuota=80%

sudo systemctl daemon-reload
sudo systemctl restart hexmon-player
```

### Reduce Memory Usage
```bash
# Reduce cache size
sudo nano /etc/hexmon/config.json
# Adjust: "maxBytes": 2147483648  (2GB)

# Limit memory in service file
sudo nano /etc/systemd/system/hexmon-player.service
# Add: MemoryLimit=1G
```

### Improve Playback Performance
```bash
# Enable hardware acceleration
sudo apt-get install libva2 libvdpau1

# Reduce transition duration
sudo nano /etc/hexmon/config.json
# Adjust: "transitionDurationMs": 300
```

## Advanced Diagnostics

### Enable Debug Logging
```bash
sudo nano /etc/hexmon/config.json
# Change: "logLevel": "debug"

sudo systemctl restart hexmon-player
```

### Capture Network Traffic
```bash
sudo tcpdump -i any -w /tmp/hexmon-traffic.pcap host api.hexmon.com
```

### Profile Performance
```bash
# CPU profiling
perf record -p $(pgrep -f hexmon-player) -g -- sleep 30
perf report

# Memory profiling
valgrind --leak-check=full hexmon-signage-player
```

## Getting Help

### Before Contacting Support

1. Collect logs: `sudo hexmon-collect-logs`
2. Check health: `curl http://127.0.0.1:3300/healthz`
3. Review recent changes
4. Check system resources
5. Verify network connectivity

### Contact Support

**Email:** support@hexmon.com

**Include:**
- Log bundle from `hexmon-collect-logs`
- Health endpoint output
- System information (OS, version, hardware)
- Steps to reproduce the issue
- Recent changes or updates

**Response Time:**
- Critical issues: 4 hours
- High priority: 24 hours
- Normal priority: 48 hours

## Additional Resources

- [Installation Guide](./INSTALL.md)
- [Security Guide](./SECURITY.md)
- [API Documentation](./API.md)
- [FAQ](https://docs.hexmon.com/faq)

---

**Last Updated:** 2025-01-05
