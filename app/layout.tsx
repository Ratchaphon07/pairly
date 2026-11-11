import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Pairly — จับคู่ช่วยกัน',
  description: 'พื้นที่จับคู่แลกเปลี่ยนความช่วยเหลือแบบ 1 ต่อ 1',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
