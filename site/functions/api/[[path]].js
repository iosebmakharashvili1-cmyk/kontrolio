// site/functions/api/[[path]].js


export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;


  // CORS-ის ჰედერები (რომ ფრონტენდმა უპრობლემოდ მიმართოს ბექენდს)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };


  // თუ ბრაუზერი აგზავნის წინასწარ შემოწმებას (Preflight)
  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }


  // როუტი 1: მომხმარებლის ავტორიზაცია (/api/login)
  if (url.pathname === "/api/login" && method === "POST") {
    try {
      const body = await request.json();
      // აქ დაწერთ ლოგინის ლოგიკას
      return new Response(JSON.stringify({ success: true, message: "ავტორიზაცია წარმატებულია" }), { headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: "არასწორი მონაცემები" }), { status: 400, headers: corsHeaders });
    }
  }


  // როუტი 2: სტატისტიკის წამოღება (/api/stats)
  if (url.pathname === "/api/stats" && method === "GET") {
    return new Response(JSON.stringify({ activeUsers: 42, Status: "OK" }), { headers: corsHeaders });
  }


  // თუ როუტი ვერ მოიძებნა
  return new Response(JSON.stringify({ error: "Route not found" }), { status: 404, headers: corsHeaders });
}

