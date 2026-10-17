FROM debian:bookworm-slim
LABEL dev.nekocode.sandbox-image="1"
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s/deb.debian.org/${DEBIAN_MIRROR}/g" /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=2 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=2 install -y --no-install-recommends \
    openssh-server ca-certificates python3 python3-gi python3-pip python3-venv gir1.2-gtk-3.0 \
    xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal dbus-x11 at-spi2-core \
    tigervnc-standalone-server x11-xserver-utils x11-utils xdotool \
    chromium chromium-sandbox fonts-dejavu-core fonts-noto-cjk \
    curl git procps libgl1-mesa-dri libglib2.0-bin xcvt nodejs npm \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
 && useradd -m -u 1000 -s /bin/bash neko && usermod -p x neko \
 && mkdir -p /home/neko/workspace && chown neko:neko /home/neko/workspace
COPY sshd_config /etc/ssh/sshd_config.neko
COPY entrypoint.py session.sh /opt/nekocode/
RUN chmod 755 /opt/nekocode/session.sh
ENV LANG=C.UTF-8
EXPOSE 22
ENTRYPOINT ["python3", "/opt/nekocode/entrypoint.py"]
