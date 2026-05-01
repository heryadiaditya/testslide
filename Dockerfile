FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    fontconfig \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV LIBREOFFICE_BIN=/usr/bin/soffice
ENV POPPLER_PDFTOPPM_BIN=/usr/bin/pdftoppm

CMD ["npm", "start"]