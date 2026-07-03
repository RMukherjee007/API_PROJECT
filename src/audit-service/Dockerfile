FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8084
CMD ["node", "src/audit-service/src/index.js"]
