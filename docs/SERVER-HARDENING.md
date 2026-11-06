# Preparing a fresh VPS

What to do on a new Debian 13 server before Cipherfilm goes on it. Cipherfilm itself stores only ciphertext,
but the machine still holds the database, the server secret and everyone's sessions, so it should be a locked
door. Everything below runs as root on the first login; the commands assume Debian 13 (trixie).

## 1. Key login and an admin user

From your own computer, create a key for this server and put it on it (asks for the root password once):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cipherfilm_vps
ssh-copy-id -i ~/.ssh/cipherfilm_vps.pub root@SERVER_IP
```

On the server, update everything and add an admin user that logs in with that key:

```bash
apt update && apt full-upgrade -y
apt install -y sudo ufw fail2ban python3-systemd unattended-upgrades apt-listchanges needrestart
adduser --disabled-password --gecos "" admin
usermod -aG sudo admin
install -d -m 700 -o admin -g admin /home/admin/.ssh
install -m 600 -o admin -g admin /root/.ssh/authorized_keys /home/admin/.ssh/authorized_keys
echo "admin ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-admin && chmod 440 /etc/sudoers.d/90-admin
```

`admin` has no password at all, so sudo can't ask for one; the key is the only way in. Check in a second terminal
that `ssh -i ~/.ssh/cipherfilm_vps admin@SERVER_IP` and `sudo -n true` work **before** the next step.

## 2. SSH: keys only, no root

`/etc/ssh/sshd_config.d/00-hardening.conf` (the first value sshd reads wins, hence `00-`):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowUsers admin
MaxAuthTries 3
LoginGraceTime 30
MaxStartups 10:30:60
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
PermitTunnel no
ClientAliveInterval 300
ClientAliveCountMax 2
```

`sshd -t` must print nothing. Debian 13 starts sshd through `ssh.socket`, so `systemctl reload ssh` can fail with
"Cannot bind any address"; that is harmless, the next connection starts sshd with the new settings. Keep your open
session until a **new** login as `admin` works and `ssh root@SERVER_IP` is refused.

## 3. Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
systemctl disable --now nftables.service
```

`nftables.service` must be off: Debian's `/etc/nftables.conf` starts with `flush ruleset` and can wipe ufw's rules at
boot. `ufw limit` refuses an address that opens more than six SSH connections in 30 seconds; scripts should reuse one
connection (`ControlMaster`).

Docker publishes container ports past ufw. That is fine for Cipherfilm: option C (Caddy) publishes exactly 80 and
443, option B binds only to `127.0.0.1`, and option A publishes nothing.

## 4. fail2ban

`/etc/fail2ban/jail.local`:

```
[DEFAULT]
backend = systemd
bantime = 1h
bantime.increment = true
bantime.maxtime = 1w
findtime = 10m
maxretry = 5
banaction = ufw

[sshd]
enabled = true
mode = normal
```

With key-only SSH it mostly keeps the log quiet. It also bans you if you try wrong keys or users a few times; lift
that from the provider's web console with `fail2ban-client unban --all`.

## 5. Automatic updates

`/etc/apt/apt.conf.d/20auto-upgrades`:

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
```

`/etc/apt/apt.conf.d/52unattended-upgrades-local`:

```
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename},label=Debian";
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-updates";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
```

A kernel update reboots the machine at 04:30 (UTC after the next step); Cipherfilm's containers restart by
themselves.

## 6. Kernel settings, time, swap

`/etc/sysctl.d/90-hardening.conf`, applied with `sysctl --system`:

```
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_rfc1337 = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.yama.ptrace_scope = 1
kernel.sysrq = 0
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
vm.swappiness = 10
```

IP forwarding is left alone: Docker needs it. Then `timedatectl set-timezone UTC`, and check that the machine has
swap (`swapon --show`); with 1–2 GB of RAM add a 1 GB swap file if there is none.

## 7. Reboot and check

Reboot once (the upgrade usually brings a new kernel), then:

```bash
ufw status
systemctl --failed
sshd -T | grep -E '^(permitrootlogin|passwordauthentication) '
fail2ban-client status sshd
```

Finally change the root password with `passwd`. You will only need it for the provider's web console.

Next: install Docker from Docker's own Debian repository and continue with [MIGRATION.md](MIGRATION.md) or
[SELF-HOSTING.md](SELF-HOSTING.md).
