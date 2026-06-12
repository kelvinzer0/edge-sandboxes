FROM python:3.12-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git build-essential && \
    rm -rf /var/lib/apt/lists/*

CMD ["bash"]
