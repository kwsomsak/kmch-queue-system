FROM node:18-alpine
WORKDIR /app

# ใช้ package.json ที่อยู่ในโฟลเดอร์ frontend
COPY frontend/package.json ./
RUN npm install

# คัดลอกโค้ดทั้งหมดในโฟลเดอร์ frontend เข้ามา
COPY frontend/ ./

RUN npm run build
EXPOSE 3000

CMD ["npm", "run", "preview"]