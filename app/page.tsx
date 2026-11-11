'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, HeartHandshake, LoaderCircle, LogIn, LogOut, ShieldCheck, Zap, Trash2, Clock, AlertTriangle, BookOpen } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type Profile = { id: string; display_name: string; avatar_url: string | null; banned_until?: string | null };
type Room = { id: string; status: string; created_at: string };

export default function Home() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const [searchSeconds, setSearchSeconds] = useState(0);
  const [banSeconds, setBanSeconds] = useState(0);
  const [onlineCount, setOnlineCount] = useState(1);
  const [showGuide, setShowGuide] = useState(false);

  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const banTimerRef = useRef<number | null>(null);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    async function loadUser() {
      const { data: { user } } = await supabase!.auth.getUser();

      if (user) {
        const { data: p } = await supabase!
          .from('profiles')
          .select('id,display_name,avatar_url,banned_until')
          .eq('id', user.id)
          .maybeSingle();

        setProfile(p as Profile | null);

        if (p?.banned_until) {
          const diff = Math.floor((new Date(p.banned_until).getTime() - Date.now()) / 1000);
          if (diff > 0) {
            setBanSeconds(diff);
          }
        }

        const { data: member } = await supabase!
          .from('room_members')
          .select('room_id, rooms(id,status,created_at)')
          .eq('user_id', user.id)
          .is('left_at', null)
          .maybeSingle();

        if (member?.rooms) {
          const roomData = member.rooms as unknown as Room;
          if (roomData && roomData.status === 'active') {
            setActiveRoom(roomData);
            router.push(`/room/${roomData.id}`);
          }
        }
      }
      setLoading(false);
    }

    loadUser();
  }, [router]);

  // ระบบนับจำนวนคนออนไลน์แบบ Realtime
  useEffect(() => {
    if (!supabase) return;
    const room = supabase.channel('online-users-global', {
      config: { presence: { key: profile?.id || Math.random().toString() } },
    });
    room.on('presence', { event: 'sync' }, () => {
      const state = room.presenceState();
      const count = Object.keys(state).length;
      setOnlineCount(count > 0 ? count : 1);
    });
    room.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await room.track({ online_at: new Date().toISOString() });
      }
    });
    return () => { supabase.removeChannel(room); };
  }, [profile]);

  useEffect(() => {
    if (banSeconds <= 0) return;

    if (banTimerRef.current) clearInterval(banTimerRef.current);
    banTimerRef.current = window.setInterval(() => {
      setBanSeconds((prev) => {
        if (prev <= 1) {
          if (banTimerRef.current) clearInterval(banTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (banTimerRef.current) clearInterval(banTimerRef.current);
    };
  }, [banSeconds]);

  useEffect(() => {
    if (!queueing || !profile || !supabase) return;

    const channel = supabase
      .channel('queue-watcher')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'room_members',
          filter: `user_id=eq.${profile.id}`,
        },
        (payload) => {
          if (payload.new && (payload.new as { room_id?: string }).room_id) {
            if (timerRef.current) clearInterval(timerRef.current);
            if (pollRef.current) clearInterval(pollRef.current);
            setQueueing(false);
            router.push(`/room/${(payload.new as { room_id: string }).room_id}`);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queueing, profile, router]);

  async function signIn() {
    if (!supabase) return;
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}/auth/callback` } });
  }

  async function signOut() { 
    if (supabase) await supabase.auth.signOut(); 
    setProfile(null); 
    setActiveRoom(null); 
  }

  async function joinQueue() {
    if (!supabase || !profile || banSeconds > 0) return;
    setQueueing(true); 
    setSearchSeconds(0);
    setNotice('กำลังค้นหาสมาชิกที่พร้อมจับคู่…');

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setSearchSeconds((prev) => prev + 1);
    }, 1000);

    const checkMatch = async () => {
      const { data, error } = await supabase!.rpc('join_match_queue');
      if (error) {
        console.error('RPC Error:', error.message);
        return false;
      }
      if (data?.room_id) {
        if (timerRef.current) clearInterval(timerRef.current);
        if (pollRef.current) clearInterval(pollRef.current);
        setQueueing(false);
        router.push(`/room/${data.room_id}`);
        return true;
      }
      return false;
    };

    const firstCheck = await checkMatch();
    if (firstCheck) return;

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      await checkMatch();
    }, 1500);
  }

  async function cancelQueue() {
    if (!supabase) return;
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    
    await supabase.rpc('leave_match_queue'); 
    setQueueing(false); 
    setSearchSeconds(0);
    setNotice('ยกเลิกการค้นหาคู่แล้ว');
  }

  async function handleClearStuckRoom() {
    if (!supabase || !profile || !activeRoom) return;
    setClearing(true);

    await supabase.from('room_members').update({ left_at: new Date().toISOString() }).eq('room_id', activeRoom.id).eq('user_id', profile.id);
    await supabase.from('rooms').update({ status: 'completed' }).eq('id', activeRoom.id);

    setClearing(false);
    setShowClearConfirm(false);
    setActiveRoom(null);
    window.location.reload();
  }

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <main className="shell">
      <nav className="nav">
        <a className="brand" href="#top">
          <span className="brand-icon"><HeartHandshake size={21} /></span>
          pairly<span className="brand-dot">.</span>
        </a>
        <div className="nav-right">
          <a href="#how" onClick={(e) => { e.preventDefault(); setShowGuide(true); }}>วิธีใช้งาน</a>
          <a href="#safety">ความปลอดภัย</a>
          {profile ? (
            <>
              <div className="user-chip">
                <img src={profile.avatar_url || '/avatar.svg'} alt="" />
                <span>{profile.display_name}</span>
              </div>
              <button className="btn btn-small btn-outline" onClick={signOut}><LogOut size={15} /> ออกจากระบบ</button>
            </>
          ) : (
            <button className="btn btn-small btn-outline" onClick={signIn}><LogIn size={15} /> เข้าสู่ระบบ</button>
          )}
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <div><span className="live-dot" /> COMMUNITY MATCHING · 1 : 1</div>
            <span style={{ color: '#52525b' }}>|</span>
            <div style={{ color: '#10b981', fontWeight: 'bold' }}>🟢 ออนไลน์ในระบบ: {onlineCount} บัญชี</div>
          </div>
          <h1>ช่วยกันคนละนิด<br /><span>ไปได้ไกลกว่า</span></h1>
          <p className="hero-desc">จับคู่กับสมาชิกอีกหนึ่งคน แลกเปลี่ยนลิงก์และช่วยเหลือกันผ่านแชท 1:1 จบในห้องเดียว</p>

          {banSeconds > 0 && (
            <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', padding: '12px 16px', borderRadius: '10px', color: '#f87171', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
              <AlertTriangle size={20} />
              <div>
                <strong>คุณถูกระงับการจับคู่ชั่วคราวจากการยุบห้อง</strong>
                <div style={{ fontSize: '0.85rem' }}>สามารถเริ่มจับคู่ใหม่ได้ในอีก: <b>{formatTime(banSeconds)} นาที</b></div>
              </div>
            </div>
          )}

          <div className="hero-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            {profile ? (
              <button className="btn btn-primary" onClick={joinQueue} disabled={queueing || banSeconds > 0} style={{ opacity: banSeconds > 0 ? 0.6 : 1, cursor: banSeconds > 0 ? 'not-allowed' : 'pointer' }}>
                {queueing ? <LoaderCircle className="spin" size={18} /> : <Zap size={18} />}
                {queueing ? `กำลังค้นหาคู่... (${searchSeconds} วินาที)` : banSeconds > 0 ? `ติดโทษแบน (${formatTime(banSeconds)})` : 'เริ่มจับคู่ตอนนี้'}
                {!queueing && banSeconds === 0 && <ArrowRight size={17} />}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={signIn}>
                <LogIn size={18} /> เข้าสู่ระบบด้วย Google <ArrowRight size={17} />
              </button>
            )}

            <button className="btn btn-outline" onClick={() => setShowGuide(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <BookOpen size={16} /> ดูคู่มือวิธีใช้งาน
            </button>

            {activeRoom && (
              <button className="btn" onClick={() => setShowClearConfirm(true)} style={{ background: '#ef4444', color: 'white', border: 'none', display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                <Trash2 size={16} /> ยุบห้องค้าง (ฉุกเฉิน)
              </button>
            )}

            {queueing && <button className="btn btn-quiet" onClick={cancelQueue}>ยกเลิกการค้นหา</button>}
          </div>

          {showClearConfirm && (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
              <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '12px', padding: '24px', maxWidth: '400px', width: '90%', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h3 style={{ color: '#f4f4f5', margin: 0 }}>⚠️ ยืนยันการยุบห้องค้างใช่หรือไม่?</h3>
                <p style={{ color: '#a1a1aa', fontSize: '0.9rem', margin: 0 }}>หากห้องเดิมเกิดปัญหา การกดปุ่มนี้จะเคลียร์สถานะเพื่อให้คุณกลับมาเริ่มหาห้องใหม่ได้ทันที</p>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '10px' }}>
                  <button onClick={() => setShowClearConfirm(false)} style={{ background: '#27272a', color: '#f4f4f5', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>ยกเลิก</button>
                  <button onClick={handleClearStuckRoom} disabled={clearing} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{clearing ? 'กำลังเคลียร์...' : 'ยืนยันยุบห้องทันที'}</button>
                </div>
              </div>
            </div>
          )}

          {/* Modal คู่มือวิธีใช้งาน */}
          {showGuide && (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '15px' }}>
              <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '16px', padding: '24px', maxWidth: '500px', width: '100%', display: 'flex', flexDirection: 'column', gap: '16px', color: '#f4f4f5', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', textAlign: 'left' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>📖 คู่มือการใช้งาน Pairly</h3>
                  <button onClick={() => setShowGuide(false)} style={{ background: 'transparent', border: 'none', color: '#a1a1aa', fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.9rem', color: '#d4d4d8', lineHeight: '1.5' }}>
                  <div style={{ background: '#27272a', padding: '10px 12px', borderRadius: '8px' }}>
                    <b>1. เข้าสู่ระบบ:</b> กดปุ่มเข้าสู่ระบบด้วย Google เพื่อเริ่มใช้งาน
                  </div>
                  <div style={{ background: '#27272a', padding: '10px 12px', borderRadius: '8px' }}>
                    <b>2. เริ่มจับคู่:</b> กดปุ่ม &quot;เริ่มจับคู่ตอนนี้&quot; ระบบจะค้นหาสมาชิกที่กดพร้อมกันให้อัตโนมัติแบบ 1:1
                  </div>
                  <div style={{ background: '#27272a', padding: '10px 12px', borderRadius: '8px' }}>
                    <b>3. ในห้องแชท:</b> สามารถพิมพ์คุยหรือส่งลิงก์ TikTok เพื่อช่วยเหลือกันได้ทันที และกดปุ่ม &quot;กดเสร็จสิ้น&quot; เมื่อทำภารกิจสำเร็จ
                  </div>
                  <div style={{ background: '#27272a', padding: '10px 12px', borderRadius: '8px' }}>
                    <b>4. กรณีห้องค้าง/มีปัญหา:</b> สามารถกดปุ่ม &quot;ยุบห้อง&quot; ฉุกเฉินได้ แต่ผู้กดจะถูกระงับการจับคู่ 10 นาที
                  </div>
                </div>

                <button onClick={() => setShowGuide(false)} style={{ background: '#2563eb', color: 'white', border: 'none', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '6px' }}>
                  เข้าใจแล้ว
                </button>
              </div>
            </div>
          )}

          {notice && (
            <div className="notice" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {queueing && <Clock size={16} className="spin" />}
              {notice} {queueing && <b>({searchSeconds} วินาที)</b>}
            </div>
          )}

          <div className="trust-line"><ShieldCheck size={15} /> ยืนยันด้วยตัวเอง · ไม่ต้องให้รหัสผ่าน TikTok</div>
        </div>
      </section>

      {loading && <div className="loading-cover"><LoaderCircle className="spin" /> กำลังโหลด…</div>}
    </main>
  );
}