FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV PORT=3000 HOST=0.0.0.0 STATE_FILE=/app/data/rooms.json
EXPOSE 3000
CMD ["node", "server/index.js"]
