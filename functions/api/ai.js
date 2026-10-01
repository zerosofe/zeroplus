export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        // قراءة مفتاح Groq من متغيرات البيئة السرية في Cloudflare
        const apiKey = env.GROQ_API_KEY;
        if (!apiKey) {
            return new Response(JSON.stringify({ 
                error: { message: "GROQ_API_KEY is not configured in Cloudflare environment variables." } 
            }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }

        // إرسال الطلب إلى Groq في السيرفر دون كشف المفتاح للواجهة
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey.trim()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: body.messages,
                temperature: 0.15,
                ...(body.jsonMode ? { response_format: { type: "json_object" } } : {})
            })
        });

        const data = await groqRes.json();
        return new Response(JSON.stringify(data), {
            status: groqRes.status,
            headers: { "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ 
            error: { message: err.message || "Internal server error" } 
        }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
