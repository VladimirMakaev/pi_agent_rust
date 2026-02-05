FROM debian:13
COPY --from=jdxcode/mise:latest /usr/local/bin/mise /usr/local/bin/mise

RUN apt update && \
    apt install -y git ca-certificates && \
    apt clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -u 10001 -m -s /bin/bash dev && \
    mkdir -p /home/dev/workspace && \
    chown -R dev:dev /home/dev && \
    echo 'eval "$(mise activate bash)"' >> /home/dev/.bashrc && \
    echo 'export PATH="/home/dev/.local/bin:/home/dev/.bun/bin:$PATH"' >> /home/dev/.bashrc

USER dev
ENV HOME=/home/dev
WORKDIR /home/dev/workspace

COPY --chown=dev:dev _mise.toml /home/dev/.config/mise/config.toml

RUN mise install

ARG PI_VERSION=latest
RUN mise use -g npm:@vaayne/pi-coding-agent@$PI_VERSION && \
    mise cache clear

CMD ["mise", "exec", "--", "pi"]
