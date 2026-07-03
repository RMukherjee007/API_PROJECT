FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8083
CMD ["node", "src/auth-service/src/index.js"]
