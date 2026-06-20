import { Link, useLocation } from "wouter";
import { Layers, HardDrive } from "lucide-react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/60 bg-card/40 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-2 cursor-pointer group">
              <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Layers className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="font-mono font-bold text-sm text-foreground">FileSplit</span>
            </div>
          </Link>

          <nav className="flex items-center gap-1">
            <Link href="/">
              <button
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                  location === "/" ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                Upload
              </button>
            </Link>
            <Link href="/files">
              <button
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors flex items-center gap-1.5 ${
                  location.startsWith("/files") ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                <HardDrive className="w-3 h-3" />
                Library
              </button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
        {children}
      </main>

      <footer className="border-t border-border/40 py-4">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-center">
          <p className="text-xs text-muted-foreground/50 font-mono">FileSplit — split, embed & distribute</p>
        </div>
      </footer>
    </div>
  );
}
