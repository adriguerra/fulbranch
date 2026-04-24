import { ChatInterface } from "@/components/chat/chat-interface";

type TaskStatus = "pending" | "in_progress" | "fixing" | "review" | "done" | "blocked";

type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  pr_url: string | null;
  pr_number: number | null;
  retries: number;
  updated_at: string;
};

const statusColors: Record<TaskStatus, string> = {
  pending: "bg-zinc-700 text-zinc-300",
  in_progress: "bg-blue-900 text-blue-300",
  fixing: "bg-yellow-900 text-yellow-300",
  review: "bg-purple-900 text-purple-300",
  done: "bg-green-900 text-green-300",
  blocked: "bg-red-900 text-red-300",
};

async function getTasks(): Promise<Task[]> {
  try {
    const apiUrl = process.env.MAINARK_API_URL ?? "http://localhost:3000";
    const res = await fetch(`${apiUrl}/api/tasks`, { cache: "no-store" });
    return res.json();
  } catch {
    return [];
  }
}

export default async function Home() {
  const tasks = await getTasks();

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Task list */}
      <div className="w-96 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-800">
          <h1 className="text-lg font-semibold">Mainark</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{tasks.length} tasks</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center mt-8">No tasks yet</p>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className="px-4 py-3 border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-100 leading-snug flex-1 min-w-0 truncate">
                    {task.title}
                  </p>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColors[task.status]}`}>
                    {task.status.replace("_", " ")}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-zinc-500 font-mono">{task.id}</span>
                  {task.pr_number && (
                    <a
                      href={task.pr_url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-blue-400 hover:underline"
                    >
                      PR #{task.pr_number}
                    </a>
                  )}
                  {task.retries > 0 && (
                    <span className="text-[11px] text-zinc-500">{task.retries} retries</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col p-4 min-w-0">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-zinc-400">AI Assistant</h2>
        </div>
        <div className="flex-1 min-h-0">
          <ChatInterface />
        </div>
      </div>
    </div>
  );
}
