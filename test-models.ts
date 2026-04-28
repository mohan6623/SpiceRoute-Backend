import { GoogleGenAI } from '@google/genai'
import dotenv from 'dotenv'
dotenv.config()

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

async function checkModels() {
  const modelsToTest = [
    'gemini-3.1-flash',
    // 'gemini-2.5-flash',
    'gemini-1.5-flash',
  ]

  for (const modelName of modelsToTest) {
    try {
      console.log(`Testing model: ${modelName}...`)
      const response = await ai.models.generateContent({
        model: modelName,
        contents: 'hi'
      })
      console.log(`✅ SUCCESS with ${modelName}. Response: ${response.text}`)
    } catch (e: any) {
      console.log(`❌ FAILED ${modelName}: ${e.message}`)
    }
  }
}

checkModels()
