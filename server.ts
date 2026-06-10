import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Lazy-loaded Gemini AI client to prevent startup failures on missing API keys
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not defined");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// AI recommendations route
app.post("/api/recommendations", async (req, res) => {
  try {
    const { 
      currentUser, 
      pastHangouts, 
      savedPlaces, 
      groupFriends, 
      candidatePlaces,
      refinementOptions 
    } = req.body;

    const ai = getGeminiClient();

    const mood = refinementOptions?.mood || "Any Mood";
    const budget = refinementOptions?.budget || "Any Budget";
    const availableTime = refinementOptions?.availableTime || "Any Time";

    const prompt = `
You are Linkup's custom AI Social Coordinator. Your job is to suggest custom-tailored meetup ideas and matching places based on social context.

CONTEXT DEFAULTS:
1. Current User: "${currentUser?.displayName || 'Social Pioneer'}", Bio: "${currentUser?.bio || ''}"
2. Group Members/Friends context: ${JSON.stringify(groupFriends || [])}
3. Past Hangouts history: ${JSON.stringify(pastHangouts || [])}
4. Saved Places: ${JSON.stringify(savedPlaces || [])}
5. Candidate Spot Options in app: ${JSON.stringify(candidatePlaces || [])}

REFINEMENT OPTIONS:
- Targeted Mood: "${mood}" (Matches can range from Chill, Energetic, Cozy, Romantic, Active, Gaming, Foodie, Outdoorsy, etc.)
- Budget Limit: "${budget}" (Matches $, $$, $$$)
- Available Time: "${availableTime}" (e.g. 1 hour, 3 hours, Full Day, Evening etc.)

Task:
Produce 3 high-quality, customized hangout recommendation options. 
Try to map recommendations to the "Candidate Spot Options" in the app by returning their exact 'id' in 'placeId' if they fit. If none match or you want to suggest a special creative spot, create a custom idea with 'customLocationName' set and 'placeId' as null.
For each option, explain the alignment with the current user's profile, past hangouts, saved spots, and mutual friends' bios. Specifically list which friend names match this proposal in "matchingFriends".
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are Linkup's visual AI recommendation engine. Respond in strict JSON matching the requested schema. Ensure all fields are filled, reasoning is personalized, and formatting is elegant and human-friendly.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          description: "List of recommended hangout suggestions",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              placeId: { type: Type.STRING, description: "The ID of the candidate place (e.g., 'p1', 'p2') if it maps, or null." },
              customLocationName: { type: Type.STRING, description: "Display name of custom spot if placeId is null." },
              reasoning: { type: Type.STRING, description: "Personalized explanation of why this matches profiles, saved items, and specific constraints." },
              recommendedTimeOfDay: { type: Type.STRING, description: "e.g., 'Late Afternoon', 'Friday Night', 'Sunday Brunch'" },
              estimatedDuration: { type: Type.STRING, description: "e.g., '2 hours', '4 hours', 'Full Day'" },
              estimatedCost: { type: Type.STRING, description: "e.g., '$', '$$', '$$$'" },
              matchingFriends: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "List of friend names who will love this idea based on their bio/profiles."
              }
            },
            required: ["title", "description", "reasoning", "recommendedTimeOfDay", "estimatedDuration", "estimatedCost", "matchingFriends"]
          }
        }
      }
    });

    const parsedData = JSON.parse(response.text?.trim() || "[]");
    return res.json({ success: true, recommendations: parsedData });
  } catch (err: any) {
    console.error("AI recommendations failed:", err);
    // Return friendly fallback data so UI never blocks
    return res.status(200).json({ 
      success: false, 
      error: err.message || "Failed to contact Gemini engine",
      recommendations: [
        {
          title: "Artisan Coffee & Casual Chat",
          description: "Meet up at a cozy local cafe to share ideas, catch up, and taste fresh custom roasts.",
          placeId: "p1",
          customLocationName: "The Daily Grind Cafe",
          reasoning: "Perfect fit for social catch-ups with friends. Fits any quick timezone and budget constraints.",
          recommendedTimeOfDay: "Mid Morning",
          estimatedDuration: "1.5 hours",
          estimatedCost: "$$",
          matchingFriends: []
        },
        {
          title: "Retro Arcade & Snacking Lounge",
          description: "Revisit childhood classics and play active console battles in a low-stress, highly positive environment.",
          placeId: "p3",
          customLocationName: "Level Up Arcade Lounge",
          reasoning: "Great high-energy ice breaker offering games, virtual reality rooms, and snack platters.",
          recommendedTimeOfDay: "Friday Night",
          estimatedDuration: "3 hours",
          estimatedCost: "$$",
          matchingFriends: []
        }
      ] 
    });
  }
});

// Google Calendar integration route
app.post("/api/calendar/add", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Please log in with Google to sync hangouts to your calendar." });
  }

  const { title, description, location, dateTime, durationMinutes, reminderMinutes } = req.body;

  try {
    const startObj = new Date(dateTime || Date.now());
    const endObj = new Date(startObj.getTime() + (durationMinutes || 120) * 60000);

    const eventPayload = {
      summary: title,
      description: `${description || "Hangout scheduled via Linkup Applet"}\n\nSynced with Linkup.`,
      location: location || "Linkup Spot",
      start: {
        dateTime: startObj.toISOString(),
        timeZone: "UTC"
      },
      end: {
        dateTime: endObj.toISOString(),
        timeZone: "UTC"
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: Number(reminderMinutes) || 1440 }
        ]
      }
    };

    const googleResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventPayload)
    });

    if (!googleResponse.ok) {
      const errText = await googleResponse.text();
      console.error("Google Calendar event creation failed:", errText);
      return res.status(googleResponse.status).json({ 
        error: `Could not insert event: ${errText}` 
      });
    }

    const data = await googleResponse.json();
    return res.json({ 
      success: true, 
      eventId: data.id, 
      htmlLink: data.htmlLink 
    });
  } catch (err: any) {
    console.error("Calendar insertion exception:", err);
    return res.status(500).json({ error: err.message || "Error adding event to Google Calendar" });
  }
});

// Vite server integrations
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Linkup local server active at http://localhost:${PORT}`);
  });
}

startServer();
