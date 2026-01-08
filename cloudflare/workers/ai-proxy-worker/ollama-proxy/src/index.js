export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (!env.OLLAMA_API_KEY) {
        return new Response(
          JSON.stringify({ error: "OLLAMA_API_KEY not configured" }), 
          { status: 500, headers: corsHeaders }
        );
      }

      const url = "https://ollama.com/v1/chat/completions";
      
      const body = await request.json();
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OLLAMA_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      console.log("Response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("API Error:", errorText);
        return new Response(
          JSON.stringify({ 
            error: "API request failed", 
            status: response.status,
            details: errorText 
          }),
          { status: response.status, headers: corsHeaders }
        );
      }

      const newResponse = new Response(response.body, response);
      Object.keys(corsHeaders).forEach(key => {
        newResponse.headers.set(key, corsHeaders[key]);
      });
      
      return newResponse;
      
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(
        JSON.stringify({ error: error.message }), 
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
