# Pairly — ระบบจับคู่ช่วยเหลือ 1:1

Starter project ด้วย Next.js 15, TypeScript, Tailwind CSS และ Supabase

## สิ่งที่มีในชุดนี้
- หน้า Landing responsive โทน Dark / Purple / Blue
- Google OAuth ผ่าน Supabase
- หน้า Room สำหรับแสดงสมาชิก แลกลิงก์ และยืนยันเสร็จสิ้น
- Supabase Realtime subscription สำหรับลิงก์ การยืนยัน และสถานะห้อง
- SQL schema สำหรับโปรไฟล์ ห้อง สมาชิก ลิงก์ คิวจับคู่ และการยืนยัน
- RPC จับคู่แบบ atomic ด้วย `FOR UPDATE SKIP LOCKED`
- RPC ปิดห้องเมื่อสมาชิกทั้งสองยืนยัน
- Row Level Security เบื้องต้น

> สถานะ: Starter implementation. ต้องตั้งค่า Supabase และ Google OAuth ก่อนจึงใช้ระบบจริงได้ ยังต้องพัฒนาหน้าประวัติ/แอดมิน, ระบบหมดอายุห้อง, moderation และ hardening ก่อนเปิดให้ผู้ใช้ทั่วไป

## ติดตั้ง
ต้องมี Node.js 20+
```bash
npm install
cp .env.example .env.local
npm run dev
```
ใส่ Supabase project URL และ anon key ใน `.env.local`

## ตั้งค่า Supabase
1. สร้าง Supabase project
2. รัน `supabase/schema.sql` ใน SQL Editor
3. Authentication → Providers → เปิด Google และตั้ง OAuth Client ID/Secret
4. Authentication → URL Configuration → เพิ่ม Site URL `http://localhost:3000` และ Redirect URL `http://localhost:3000/auth/callback`
5. เพิ่ม URL ของ production ภายหลังเมื่อ deploy

## ความปลอดภัย
- ห้ามใส่ `service_role` key ใน browser หรือ `NEXT_PUBLIC_*`
- การยืนยันเป็น self-report ไม่ใช่การยืนยันจาก TikTok
- ไม่มีระบบคลิก TikTok อัตโนมัติ
- ก่อน production ควรเพิ่ม rate limit, cleanup งานค้าง, audit logs, moderation และทดสอบ RLS/concurrency
