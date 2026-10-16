const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const db = new sqlite3.Database('./kmch_queue.db', (err) => {
  if (err) console.error('Database opening error: ', err.message);
  else console.log('Connected to SQLite database.');
});

/*
const db = new sqlite3.Database('./kmch_queue.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
    
    // สร้างตาราง queues
    db.run(`CREATE TABLE IF NOT EXISTS queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_name TEXT,
      VN TEXT,
      queue_status TEXT,
      created_at TEXT
    )`);

    // สร้างตาราง rooms (รองรับ room_number และ room_name)
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT UNIQUE,
      room_name TEXT
    )`);

    // สร้างตาราง doctors (รองรับ room_number, room_name และ doctor_name)
    db.run(`CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT UNIQUE,
      room_name TEXT,
      doctor_name TEXT
    )`);
  }
});

// สั่งให้เช็กและเพิ่มคอลัมน์ room_number ในตาราง rooms ให้อัตโนมัติเมื่อสตาร์ท Server
db.run(`ALTER TABLE rooms ADD COLUMN room_number VARCHAR(10)`, (err) => {
  if (err) {
    console.log('Column room_number in rooms table already exists.');
  } else {
    console.log('Successfully added room_number column to rooms table!');
  }
});
*/

// Initialize Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, room_number TEXT, room_name TEXT, usage_status TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS doctors (id INTEGER PRIMARY KEY AUTOINCREMENT, doctor_name TEXT, room_name TEXT, started_at TEXT, finished_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS queues (id INTEGER PRIMARY KEY AUTOINCREMENT, VN TEXT, room_name TEXT, queue_status TEXT, created_at TEXT, updated_at TEXT)`);
});

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('update_queue', () => {
    io.emit('refresh_queue');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// API: ดึงรายการคิวทั้งหมด
app.get('/api/queues', (req, res) => {
  db.all(`SELECT * FROM queues ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/queue/add', (req, res) => {
  const { room_number, room_name, VN } = req.body;
  if (!room_name || !VN) return res.status(400).json({ error: 'Missing required fields' });

  // เช็กซ้ำในฐานข้อมูลก่อนเพิ่ม
  db.get(`SELECT id FROM queues WHERE VN = ?`, [VN], (err, row) => {
    if (row) {
      return res.status(400).json({ message: `เลข VN: ${VN} มีอยู่ในระบบแล้ว` });
    }

    const query = `INSERT INTO queues (room_name, VN, queue_status, created_at) VALUES (?, ?, 'waiting', datetime('now', 'localtime'))`;
    db.run(query, [room_name, VN], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('refresh_queue');
      res.json({ message: 'Queue added successfully', id: this.lastID });
    });
  });
});

// API: ลงทะเบียนคิว
app.post('/api/queues', (req, res) => {
  const { VN, room_name } = req.body;
  
  db.get(`SELECT * FROM queues WHERE VN = ? AND queue_status != 'closed'`, [VN], (err, row) => {
    if (row) {
      return res.status(400).json({ error: 'VN นี้มีอยู่ในระบบและยังไม่ปิดคิว' });
    }

    const now = new Date().toISOString();
    db.run(`INSERT INTO queues (VN, room_name, queue_status, created_at, updated_at) VALUES (?, ?, 'waiting', ?, ?)`,
      [VN, room_name, now, now], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('refresh_queue');
        res.json({ id: this.lastID, VN, room_name, queue_status: 'waiting' });
      });
  });
});

// API สำหรับลบคิวรายรายการตาม ID
app.delete('/api/queue/:id', (req, res) => {
  const queueId = req.params.id;
  
  const query = `DELETE FROM queues WHERE id = ?`;
  
  db.run(query, [queueId], function(err) {
    if (err) {
      console.error('Error deleting queue:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    // แจ้งเตือนทุกหน้าจอผ่าน Socket.io ให้รีเฟรชข้อมูลแบบเรียลไทม์
    io.emit('refresh_queue');
    
    res.json({ message: 'Queue deleted successfully', changes: this.changes });
  });
});

// API: เปลี่ยนสถานะคิว
app.put('/api/queues/:id/status', (req, res) => {
  const { id } = req.params;
  const { queue_status, room_name } = req.body;
  const now = new Date().toISOString();

  let query = `UPDATE queues SET queue_status = ?, updated_at = ?`;
  let params = [queue_status, now];

  if (room_name) {
    query += `, room_name = ?`;
    params.push(room_name);
  }
  query += ` WHERE id = ?`;
  params.push(id);

  db.run(query, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('refresh_queue');
    res.json({ success: true });
  });
});

// API สำหรับบันทึกหรือเปลี่ยนชื่อห้องตรวจ (รองรับทั้งเพิ่มใหม่และอัปเดตห้องเดิม)
app.post('/api/rooms', (req, res) => {
  const { room_number, room_name } = req.body;

  if (!room_number || !room_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 1. ตรวจสอบก่อนว่ามีหมายเลขห้องนี้อยู่แล้วหรือยัง
  db.get(`SELECT id FROM rooms WHERE room_number = ?`, [room_number], (err, row) => {
    if (err) {
      console.error('Database Error:', err.message);
      return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการตรวจสอบฐานข้อมูล' });
    }

    if (row) {
      // 2. ถ้ามีอยู่แล้ว -> ทำการ UPDATE เปลี่ยนชื่อห้องใหม่
      const updateQuery = `UPDATE rooms SET room_name = ? WHERE room_number = ?`;
      db.run(updateQuery, [room_name, room_number], function(err) {
        if (err) {
          console.error('Update Room Error:', err.message);
          return res.status(500).json({ message: 'ไม่สามารถอัปเดตชื่อห้องตรวจได้' });
        }
        io.emit('refresh_queue');
        res.json({ message: 'Room updated successfully' });
      });
    } else {
      // 3. ถ้ายังไม่มี -> ทำการ INSERT เพิ่มห้องใหม่
      const insertQuery = `INSERT INTO rooms (room_number, room_name) VALUES (?, ?)`;
      db.run(insertQuery, [room_number, room_name], function(err) {
        if (err) {
          console.error('Insert Room Error:', err.message);
          return res.status(500).json({ message: 'ไม่สามารถเพิ่มห้องตรวจใหม่ได้' });
        }
        io.emit('refresh_queue');
        res.json({ message: 'Room added successfully', id: this.lastID });
      });
    }
  });
});

// --- ส่วนของ Rooms API ---
app.get('/api/rooms', (req, res) => {
  db.all(`SELECT * FROM rooms`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (rows.length === 0) {
      const defaultRooms = [
        { room_number: '01', room_name: 'คลินิกศัลยกรรมทั่วไป' },
        { room_number: '02', room_name: 'ศูนย์สมองและโรคปวดศีรษะ' },
        { room_number: '03', room_name: 'ศูนย์อายุรกรรมโรคหัวใจ' },
        { room_number: '04', room_name: 'ศูนย์โรคปอดและการนอนหลับ' },
        { room_number: '05', room_name: 'คลินิกนรีเวช' },
        { room_number: '06', room_name: 'คลินิกความจำ' },
        { room_number: '07', room_name: 'คลินิกกระดูกและข้อ' },
        { room_number: '08', room_name: 'คลินิกฝังเข็ม' },
      ];

      const stmt = db.prepare(`INSERT INTO rooms (room_number, room_name, usage_status) VALUES (?, ?, 'active')`);
      defaultRooms.forEach(r => stmt.run(r.room_number, r.room_name));
      stmt.finalize();

      db.all(`SELECT * FROM rooms`, [], (err2, newRows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(newRows);
      });
    } else {
      res.json(rows);
    }
  });
});

app.put('/api/rooms/:id', (req, res) => {
  const { id } = req.params;
  const { room_number, room_name, usage_status } = req.body;
  db.run(`UPDATE rooms SET room_number = ?, room_name = ?, usage_status = ? WHERE id = ?`,
    [room_number, room_name, usage_status, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('refresh_queue');
      res.json({ success: true });
    });
});

// --- ส่วนของ Doctors API ---
app.get('/api/doctors', (req, res) => {
  db.all(`SELECT * FROM doctors`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // ถ้ายังไม่มีข้อมูลแพทย์ ให้สร้างค่าเริ่มต้น 8 คน
    if (rows.length === 0) {
      const defaultDoctors = [
        { doctor_name: 'นพ. สมชาย ใจดี', room_name: 'คลินิกศัลยกรรมทั่วไป' },
        { doctor_name: 'พญ. 1', room_name: 'ศูนย์สมองและโรคปวดศีรษะ' },
        { doctor_name: 'นพ. 2', room_name: 'ศูนย์อายุรกรรมโรคหัวใจ' },
        { doctor_name: 'พญ. 3', room_name: 'ศูนย์โรคปอดและการนอนหลับ' },
        { doctor_name: 'นพ. 4', room_name: 'คลินิกนรีเวช' },
        { doctor_name: 'พญ. 5', room_name: 'คลินิกความจำ' },
        { doctor_name: 'นพ. 6', room_name: 'คลินิกกระดูกและข้อ' },
        { doctor_name: 'พญ. 7', room_name: 'คลินิกฝังเข็ม' },
      ];

      const stmt = db.prepare(`INSERT INTO doctors (doctor_name, room_name) VALUES (?, ?)`);
      defaultDoctors.forEach(d => stmt.run(d.doctor_name, d.room_name));
      stmt.finalize();

      db.all(`SELECT * FROM doctors`, [], (err2, newRows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(newRows);
      });
    } else {
      res.json(rows);
    }
  });
});

app.put('/api/doctors/:id', (req, res) => {
  const { id } = req.params;
  const { doctor_name, room_name } = req.body;
  db.run(`UPDATE doctors SET doctor_name = ?, room_name = ? WHERE id = ?`,
    [doctor_name, room_name, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// API สำหรับบันทึกหรืออัปเดตแพทย์ประจำห้องตรวจ (ค้นหาด้วย room_name)
app.post('/api/doctors', (req, res) => {
  const { room_name, doctor_name } = req.body;

  if (!room_name || !doctor_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 1. ตรวจสอบว่าห้องตรวจนี้มีแพทย์ประจำอยู่แล้วหรือยัง โดยใช้ room_name เป็นเงื่อนไข
  db.get(`SELECT id FROM doctors WHERE room_name = ?`, [room_name], (err, row) => {
    if (err) {
      console.error('Database Error:', err.message);
      return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการตรวจสอบฐานข้อมูล' });
    }

    if (row) {
      // 2. ถ้ามีห้องนี้อยู่แล้ว -> ทำการ UPDATE เปลี่ยนชื่อแพทย์ใหม่ตามชื่อห้อง
      const updateQuery = `UPDATE doctors SET doctor_name = ? WHERE room_name = ?`;
      db.run(updateQuery, [doctor_name, room_name], function(err) {
        if (err) {
          console.error('Update Doctor Error:', err.message);
          return res.status(500).json({ message: 'ไม่สามารถอัปเดตชื่อแพทย์ได้' });
        }
        io.emit('refresh_queue');
        res.json({ message: 'Doctor updated successfully' });
      });
    } else {
      // 3. ถ้ายังไม่มี -> ทำการ INSERT เพิ่มแพทย์ประจำห้องใหม่
      const insertQuery = `INSERT INTO doctors (room_name, doctor_name) VALUES (?, ?)`;
      db.run(insertQuery, [room_name, doctor_name], function(err) {
        if (err) {
          console.error('Insert Doctor Error:', err.message);
          return res.status(500).json({ message: 'ไม่สามารถบันทึกแพทย์ประจำห้องได้' });
        }
        io.emit('refresh_queue');
        res.json({ message: 'Doctor added successfully', id: this.lastID });
      });
    }
  });
});

app.post('/api/queues', (req, res) => {
  const { VN, room_number, room_name } = req.body;
  
  db.get(`SELECT * FROM queues WHERE VN = ? AND queue_status != 'closed'`, [VN], (err, row) => {
    if (row) {
      return res.status(400).json({ error: 'VN นี้มีอยู่ในระบบและยังไม่ปิดคิว' });
    }

    const now = new Date().toISOString();
    // บันทึกทั้ง room_number และ room_name ลงตาราง queues
    db.run(`INSERT INTO queues (VN, room_number, room_name, queue_status, created_at, updated_at) VALUES (?, ?, ?, 'waiting', ?, ?)`,
      [VN, room_number, room_name, now, now], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('refresh_queue');
        res.json({ id: this.lastID, VN, room_number, room_name, queue_status: 'waiting' });
      });
  });
});

// API สำหรับเคลียร์คิวทั้งหมดในระบบ (เริ่มวันใหม่)
app.delete('/api/queues/clear', (req, res) => {
  const query = `DELETE FROM queues`; // หรือใช้ชื่อตารางคิวของคุณตามจริง
  db.run(query, [], function(err) {
    if (err) {
      console.error('Error clearing queues:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    // แจ้งเตือนทุกหน้าจอผ่าน Socket.io ให้รีเฟรชข้อมูลแบบเรียลไทม์
    io.emit('refresh_queue');
    
    res.json({ message: 'Cleared all queues successfully', changes: this.changes });
  });
});

httpServer.listen(4000, () => {
  console.log('Server running on port 4000');
});