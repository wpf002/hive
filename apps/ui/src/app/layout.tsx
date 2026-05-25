import './globals.css';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Providers from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata = { title: 'Hive', description: 'Distributed bot orchestration' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrains.variable}`}>
      <body className="bg-hive-bg text-hive-text min-h-screen bg-hex-grid font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
