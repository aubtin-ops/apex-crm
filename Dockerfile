FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-optional
COPY src/ ./src/
COPY public/ ./public/
EXPOSE 3100
CMD ["node", "src/server.js"]
