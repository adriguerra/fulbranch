export async function GET() {
  const apiUrl = process.env.FULBRANCH_API_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${apiUrl}/api/tasks`, { cache: "no-store" });
    const data = await res.json();
    return Response.json(data);
  } catch {
    return Response.json([], { status: 200 });
  }
}
