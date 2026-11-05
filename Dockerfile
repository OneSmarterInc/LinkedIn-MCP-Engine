# Backend API (and MCP server code) in one container.
# Build:  docker build -t linkedin-mcp-engine .
# Run:    docker run --env-file .env -v %cd%/secrets:/app/secrets -v %cd%/data:/app/data -v %cd%/out:/app/out -p 8787:8787 linkedin-mcp-engine
FROM node:22-slim

# Python and JobSpy, for JOB_SEARCH_SOURCE=jobspy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages python-jobspy \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV API_HOST=0.0.0.0 \
    API_PORT=8787 \
    JOBSPY_PYTHON=python3
EXPOSE 8787
CMD ["npm", "run", "api"]
