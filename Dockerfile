FROM oven/bun:1-debian
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         git curl ca-certificates gnupg nodejs npm \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user. Claude Code CLI refuses --dangerously-skip-permissions
# when running as root, so the orchestrator must run as an unprivileged user.
RUN useradd -m -u 1001 -s /bin/bash orchestrator

# Orchestrator app
WORKDIR /app
COPY package.json ./
COPY bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts

# Ensure mount points exist and are owned by the orchestrator user
RUN mkdir -p /data /repo /worktrees \
    && chown -R orchestrator:orchestrator /app /data /repo /worktrees

USER orchestrator

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]