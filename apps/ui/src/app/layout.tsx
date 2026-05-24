import './globals.css';

export const metadata = { title: 'Hive', description: 'Distributed bot orchestration' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-hive-bg text-hive-text min-h-screen bg-hex-grid">
        {children}
      </body>
    </html>
  );
}
