FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development

# ffmpeg for the live relay and transcoders. The VA drivers let it encode on
# Intel / AMD graphics when the host's /dev/dri is passed in
# (docker-compose.vaapi.yml); without that they are simply unused. NVENC needs
# no package here: the NVIDIA runtime injects its libraries
# (docker-compose.nvidia.yml).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers intel-media-va-driver \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5000

CMD ["sh", "-c", "npx sequelize-cli db:migrate && (npx sequelize-cli db:seed:all || true) && node src/server.js"]
