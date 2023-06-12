// deno-lint-ignore-file no-explicit-any

import * as openai from 'npm:openai'
import * as axios from 'npm:axios'
import ora from 'npm:ora'
import fg from 'npm:fast-glob'
import { DB } from 'https://deno.land/x/sqlite@v3.7.0/mod.ts'
import * as path from 'https://deno.land/std@0.180.0/path/mod.ts'
import * as fs from 'node:fs'
import PQueue from 'npm:p-queue'
import * as MusicMetadata from 'npm:music-metadata'

import 'https://deno.land/std@0.180.0/dotenv/load.ts'

const TRANSCRIPTION_CONCURRENCY = 2
const LABELLING_CONCURRENCY = 2

const openaiApi = new openai.OpenAIApi(
  new openai.Configuration({
    apiKey: Deno.env.get('OPENAI_API_KEY')!,
  })
)

const memosDb = new DB('memos.sqlite')

memosDb.execute('CREATE TABLE IF NOT EXISTS memos (name, content, label)')

function logOpenaiError(err: axios.AxiosError<any>) {
  console.error(
    'Error',
    JSON.stringify({ code: err.code, message: err.message, response: err.response?.data }, null, 2)
  )
}

{
  let files = await fg(Deno.env.get('VOICE_MEMOS_GLOB')!)
  console.log(`Found ${files.length} memos`)

  {
    const files2 = []
    for (const file of files) {
      const name = path.basename(file)
      const exists = memosDb.query('SELECT * FROM memos WHERE name = ?', [name]).length > 0
      const tooLarge = (await Deno.stat(file)).size > 3_000_000
      if (tooLarge) console.log(`Skipping large file ${file}`)
      if (!exists && !tooLarge) files2.push(file)
    }
    files = files2
  }

  const queue = new PQueue({ concurrency: TRANSCRIPTION_CONCURRENCY })
  const spinner = ora(`Transcribing...`).start()
  let remaining = files.length
  const current = new Set() // files currently being processed
  const updateSpinner = () => {
    spinner.text = `Transcribing... ${remaining}/${files.length} left`
    if (current.size > 0) spinner.text += ' [' + Array.from(current.values()).join(' ') + ']'
  }

  queue.addAll(
    files.map((file) => async () => {
      const name = path.basename(file)

      current.add(name)
      updateSpinner()

      const meta = await MusicMetadata.parseBuffer(await Deno.readFile(file))
      if (meta.format.duration === undefined) {
        console.log(`File seems to be corrupted: ${file}`)
      } else {
        const result = await openaiApi
          .createTranscription(fs.createReadStream(file), 'whisper-1')
          .catch(logOpenaiError)
        if (result && result.data.text) {
          memosDb.query('INSERT INTO memos (name, content) VALUES (?, ?)', [name, result.data.text])
        }
      }

      current.delete(name)
      remaining--
      updateSpinner()
    })
  )

  await queue.onIdle()
  spinner.succeed()
}

// Now categorize the memos
async function categorize(transcript: string) {
  const result = await openaiApi
    .createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: Deno.env.get('CATEGORIZATION_PROMPT')! + '\n\n' + transcript,
        },
      ],
    })
    .catch(logOpenaiError)
  if (result && result.data.choices[0].message?.content!) {
    return result.data.choices[0].message?.content!.toLowerCase()
  }
}

{
  const memos: [string, string][] = memosDb.query(
    'SELECT name, content FROM memos WHERE label IS NULL'
  )
  const spinner = ora(`Labelling...`).start()
  let remaining = memos.length
  const current = new Set()
  const updateSpinner = () => {
    spinner.text = `Labelling... ${remaining}/${memos.length} left`
    if (current.size > 0) spinner.text += ' [' + Array.from(current.values()).join(' ') + ']'
  }

  const queue = new PQueue({ concurrency: LABELLING_CONCURRENCY })

  queue.addAll(
    memos.map(([name, content]) => async () => {
      current.add(name)
      updateSpinner()

      const label = await categorize(content)
      if (label && /^[a-z]+$/.test(label)) {
        memosDb.query('UPDATE memos SET label = ? WHERE name = ?', [label, name])
      } else {
        console.error(`${name}: unknown label ${JSON.stringify(label)}`)
      }

      current.delete(name)
      remaining--
      updateSpinner()
    })
  )

  await queue.onIdle()
  spinner.succeed()
}

memosDb.close()
Deno.exit()
