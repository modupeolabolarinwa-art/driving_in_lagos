FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080 DB_FILE=/data/lagos-driver.db
VOLUME /data
EXPOSE 8080
CMD ["node", "--no-warnings", "server/index.js"]
