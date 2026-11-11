'use client';
import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CheckCircle2, Clipboard, LoaderCircle, Send, MessageSquare, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type Confirmation = { user_id: string };
type MessageRow = {
  id: string;
  room_id: string;
  user_id: string | null;
  content: string;
  created_at: string;
};

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [uid, setUid] = useState('');
  const [confirmed, setConfirmed] = useState<Confirmation[]>([]);
  const [status, setStatus] = useState('active');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [profilesMap, setProfilesMap] = useState<{ [key: string]: string }>({});
  const [inputMessage, setInputMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  async function refreshRoom() {
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { router.push('/'); return; }
    setUid(auth.user.id);

    const [m, c, r] = await Promise.all([
      supabase.from('room_members').select('user_id,profiles(display_name)').eq('room_id', id).is('left_at', null),
      supabase.from('room_confirmations').select('user_id').eq('room_id', id),
      supabase.from('rooms').select('status').eq('id', id).single(),
    ]);

    const memberData = (m.data || []) as any[];
    const newConfirmed = (c.data || []) as Confirmation[];

    setConfirmed(newConfirmed);
    
    if (r.data) {
      setStatus(r.data.status);
      if (r.data.status === 'completed') {
        window.location.href = '/';
        return;
      }
    }

    const nameMap: { [key: string]: string } = {};
    memberData.forEach(mem => {
      if (mem.user_id && mem.profiles?.display_name) {
        nameMap[mem.user_id] = mem.profiles.display_name;
      }
    });
    setProfilesMap(nameMap);
  }

  async function loadMessages() {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('room_messages')
      .select('id, room_id, user_id, content, created_at')
      .eq('room_id', id)
      .order('created_at', { ascending: true });
    
    if (!error && data) {
      setMessages((prev) => {
        if (prev.length !== data.length) {
          return data as MessageRow[];
        }
        return prev;
      });
    }
  }

  function scrollToBottom() {
    setTimeout(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }

  useEffect(() => {
    refreshRoom();
    loadMessages();
    if (!supabase) return;

    const intervalPoll = setInterval(() => {
      loadMessages();
      refreshRoom();
    }, 2500);

    const channel = supabase.channel(`room-live-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_confirmations', filter: `room_id=eq.${id}` }, async (payload) => {
        refreshRoom();
        if (payload.new && (payload.new as any).user_id) {
          const confirmerId = (payload.new as any).user_id;
          const { data: prof } = await supabase.from('profiles').select('display_name').eq('id', confirmerId).single();
          const name = prof?.display_name || 'คู่จับคู่';
          
          setMessages((prev) => {
            const notifId = `notif-${confirmerId}`;
            if (prev.some(m => m.id === notifId)) return prev;
            return [...prev, {
              id: notifId,
              room_id: id,
              user_id: null,
              content: `🔔 แจ้งเตือน: คุณ ${name} ได้กดยืนยันความช่วยเหลือเรียบร้อยแล้ว!`,
              created_at: new Date().toISOString()
            }];
          });
          scrollToBottom();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        const updatedRoom = payload.new as any;
        if (updatedRoom && updatedRoom.status === 'completed') {
          window.location.href = '/';
        } else {
          refreshRoom();
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${id}` }, (payload) => {
        const newMessage = payload.new as MessageRow;
        setMessages((prev) => {
          if (prev.some(m => m.id === newMessage.id)) return prev;
          return [...prev, newMessage];
        });
        scrollToBottom();
      })
      .subscribe();

    return () => {
      clearInterval(intervalPoll);
      supabase.removeChannel(channel);
    };
  }, [id, router]);

  async function confirmDone() {
    if (!supabase) return; 
    setBusy(true);
    const { data, error } = await supabase.rpc('confirm_room_done', { p_room_id: id });
    setBusy(false); 
    
    if (error) {
      setMessage(error.message);
    } else {
      await supabase.from('room_messages').insert({
        room_id: id,
        user_id: uid,
        content: '✅ [ระบบแจ้งเตือน]: ฉันได้กดยืนยันความช่วยเหลือเรียบร้อยแล้วครับ'
      });

      if (data?.completed) {
        setMessage('ทั้งสองฝ่ายยืนยันแล้ว กำลังพากลับหน้าหลัก...');
        await supabase.from('rooms').update({ status: 'completed' }).eq('id', id);
        setTimeout(() => { window.location.href = '/'; }, 1000);
      } else {
        setMessage('ยืนยันแล้ว กำลังรออีกฝ่ายกดยืนยัน');
        refreshRoom();
      }
    }
  }

  async function forceExitRoom() {
    if (!supabase || !uid) return;
    setBusy(true);

    try {
      // เรียกใช้งาน RPC ฝั่งเซิร์ฟเวอร์โดยตรงเพื่อข้ามปัญหา RLS
      await supabase.rpc('force_exit_room', { p_room_id: id });
    } catch (err) {
      console.error("Exit room error:", err);
    } finally {
      setBusy(false);
      window.location.href = '/';
    }
  }

  async function copyText(value: string) { 
    await navigator.clipboard.writeText(value); 
    setMessage('คัดลอกข้อความ/ลิงก์แล้ว');
    setTimeout(() => setMessage(''), 2000);
  }

  async function sendMessage(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!supabase || !inputMessage.trim() || sendingMessage) return;

    const contentText = inputMessage.trim();
    if (contentText.length > 2000) {
      setMessage('ข้อความยาวเกิน 2,000 ตัวอักษร');
      return;
    }

    setSendingMessage(true);
    const { error } = await supabase.from('room_messages').insert({
      room_id: id,
      user_id: uid,
      content: contentText
    });

    setSendingMessage(false);
    if (error) {
      setMessage(`ส่งข้อความไม่สำเร็จ: ${error.message}`);
    } else {
      setInputMessage('');
      loadMessages();
      scrollToBottom();
    }
  }

  const mineConfirmed = confirmed.some(x => x.user_id === uid);
  const partnerConfirmed = confirmed.some(x => x.user_id !== uid);

  return (
    <main className="room-shell" style={{ maxWidth: '850px', margin: '0 auto', padding: '15px' }}>
      <header className="room-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '0.8rem', background: '#2563eb', color: 'white' }}>แชท 1:1</span>
        </div>
        <button onClick={() => setShowExitConfirm(true)} style={{ background: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', padding: '6px 12px', fontSize: '0.8rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 'bold' }}>
          <Trash2 size={14}/> ยุบห้อง (แก้ห้องค้าง/บัค)
        </button>
      </header>

      {showExitConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '12px', padding: '24px', maxWidth: '400px', width: '90%', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ color: '#f4f4f5', margin: 0 }}>⚠️ ยืนยันการยุบห้อง (แก้ห้องค้าง/บัค) ใช่หรือไม่?</h3>
            <p style={{ color: '#a1a1aa', fontSize: '0.9rem', margin: 0 }}>การยุบห้องจะปิดห้องนี้ทันทีสำหรับทั้งสองฝ่าย และผู้กดจะถูกระงับการจับคู่เป็นเวลา 10 นาที</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '10px' }}>
              <button onClick={() => setShowExitConfirm(false)} style={{ background: '#27272a', color: '#f4f4f5', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>ยกเลิก</button>
              <button onClick={forceExitRoom} disabled={busy} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{busy ? 'กำลังยุบ...' : 'ยืนยันยุบห้องทันที'}</button>
            </div>
          </div>
        </div>
      )}

      <section className="room-main" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '12px', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '15px', fontSize: '0.85rem', color: '#a1a1aa' }}>
            <span>คุณ: {mineConfirmed ? '✅ ยืนยันแล้ว' : '⏳ ยังไม่ยืนยัน'}</span>
            <span>คู่: {partnerConfirmed ? '✅ ยืนยันแล้ว' : '⏳ ยังไม่ยืนยัน'}</span>
          </div>
          <button onClick={confirmDone} disabled={busy || mineConfirmed || status === 'completed'} style={{ background: mineConfirmed ? '#059669' : '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {busy ? <LoaderCircle className="spin" size={16}/> : <CheckCircle2 size={16}/>} 
            {mineConfirmed ? 'ยืนยันแล้ว' : 'กดเสร็จสิ้น'}
          </button>
        </div>

        <section className="ticket-chat-container" style={{ background: '#121214', border: '1px solid #27272a', borderRadius: '12px', display: 'flex', flexDirection: 'column', height: '480px', overflow: 'hidden' }}>
          <div className="chat-header" style={{ padding: '10px 14px', borderBottom: '1px solid #27272a', background: '#18181b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '0.9rem', color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <MessageSquare size={15} color="#38bdf8"/> ส่งลิงก์ TikTok ในแชทนี้
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#10b981' }}>● Live Sync</span>
          </div>

          <div className="chat-messages" style={{ flex: 1, padding: '14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#71717a', margin: 'auto', fontSize: '0.85rem' }}>ยังไม่มีข้อความ ส่งลิงก์ TikTok หรือพิมพ์คุยกันได้เลย!</div>
            ) : (
              messages.map((msg) => {
                if (!msg.user_id) {
                  return (
                    <div key={msg.id} style={{ alignSelf: 'center', background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', padding: '6px 12px', borderRadius: '16px', fontSize: '0.8rem', margin: '4px 0', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                      {msg.content}
                    </div>
                  );
                }

                const isMe = msg.user_id === uid;
                const senderName = isMe ? 'คุณ' : (profilesMap[msg.user_id] || 'คู่จับคู่');
                const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                return (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    <div style={{ fontSize: '0.7rem', color: '#a1a1aa', marginBottom: '2px', padding: '0 4px' }}>{senderName} {timeStr}</div>
                    <div style={{ maxWidth: '85%', padding: '9px 12px', borderRadius: '10px', background: isMe ? '#2563eb' : '#27272a', color: '#f4f4f5', wordBreak: 'break-word', fontSize: '0.9rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span>{msg.content}</span>
                      <button onClick={() => copyText(msg.content)} style={{ alignSelf: 'flex-end', background: 'rgba(0,0,0,0.2)', border: 'none', color: '#38bdf8', fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Clipboard size={11}/> คัดลอก
                      </button>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={chatBottomRef} />
          </div>

          <form onSubmit={sendMessage} style={{ display: 'flex', padding: '10px', background: '#18181b', borderTop: '1px solid #27272a', gap: '6px' }}>
            <input 
              type="text" 
              value={inputMessage} 
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="วางลิงก์ TikTok หรือพิมพ์คุย..." 
              maxLength={2000}
              style={{ flex: 1, background: '#27272a', border: '1px solid #3f3f46', borderRadius: '8px', padding: '9px 12px', color: '#f4f4f5', outline: 'none', fontSize: '0.85rem' }}
            />
            <button type="submit" disabled={sendingMessage || !inputMessage.trim()} style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', padding: '0 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', opacity: (sendingMessage || !inputMessage.trim()) ? 0.6 : 1 }}>
              {sendingMessage ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            </button>
          </form>
        </section>

        {message && <div className="room-message" style={{ padding: '8px', background: '#27272a', borderRadius: '8px', textAlign: 'center', fontSize: '0.85rem', color: '#38bdf8' }}>{message}</div>}
      </section>
    </main>
  );
}