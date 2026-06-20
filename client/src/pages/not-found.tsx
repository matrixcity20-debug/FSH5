import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { FileX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-16 h-16 rounded-2xl bg-muted/50 border border-border flex items-center justify-center mb-4">
        <FileX className="w-7 h-7 text-muted-foreground" />
      </div>
      <h1 className="text-2xl font-mono font-bold mb-2 gradient-text">404</h1>
      <p className="text-muted-foreground text-sm mb-6">Page not found.</p>
      <Link href="/">
        <Button className="font-mono text-xs">Go Home</Button>
      </Link>
    </div>
  );
}
