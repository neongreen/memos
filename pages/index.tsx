import Head from 'next/head'
import { Button, Space, Table, notification, Typography, Modal } from 'antd'
import styles from './index.module.scss'
import { invoke } from '@tauri-apps/api/tauri'
import React, { useEffect, useState } from 'react'
import { useWindowSize } from '@react-hook/window-size/throttled'
import { useHotkeys } from 'react-hotkeys-hook'
import * as R from 'ramda'
import scrollIntoView from 'scroll-into-view-if-needed'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import ReactDOMServer from 'react-dom/server'
import * as cheerio from 'cheerio'
import copyToClipboard from 'copy-to-clipboard'

type Row = { name: string; content: string; label: string }

type TiptapMethods = {
  getContent: () => Row['content']
}

const Tiptap = React.forwardRef(
  (props: { content: Row['content'] }, ref: React.ForwardedRef<TiptapMethods>) => {
    const editor = useEditor(
      {
        extensions: [StarterKit],
        content: contentToHtml(props.content),
      },
      [props.content]
    )
    React.useImperativeHandle(ref, () => ({
      getContent: () => {
        let html: string
        if (editor) html = editor.getHTML()
        else throw new Error(`Could not fetch editor content`)
        return htmlToContent(html)
      },
    }))
    return <EditorContent editor={editor} className={styles.tiptap} />
  }
)
Tiptap.displayName = 'Tiptap'

/**
 * Parse paragraph breaks and create a React fragment
 */
function contentToReact(content: string): React.ReactElement {
  return (
    <>
      {content.split('\n\n').map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  )
}

/**
 * Parse paragraph breaks and create HTML
 */
function contentToHtml(content: string): string {
  return ReactDOMServer.renderToStaticMarkup(contentToReact(content))
}

/**
 * Inverse of `contentToHtml`
 */
function htmlToContent(html: string): string {
  const $ = cheerio.load(html)
  return Array.from($('p'))
    .map((p) => $.text([p]))
    .join('\n\n')
}

/**
 * Focused row style for memo table rows.
 */
function focusedMemoRowStyle(selector: string) {
  let focusBorderColor = 'color(srgb 0.0892 0.4658 0.999)'
  let focusRowColor = '#fffbe5'
  return `
    ${selector} {
      background-color: ${focusRowColor};
    }
    :is(${selector}) > td {
      transition: none !important;
      box-shadow: 0px 1.5px ${focusBorderColor} inset, 0px -1.5px ${focusBorderColor} inset;
    }
    :is(${selector}) > td:first-child {
      box-shadow: 
        0px 1.5px ${focusBorderColor} inset,
        0px -1.5px ${focusBorderColor} inset,
        1.5px 0px ${focusBorderColor} inset;
      border-top-left-radius: 2px;
      border-bottom-left-radius: 2px;
    }
    :is(${selector}) > td:last-child {
      box-shadow:
        0px 1.5px ${focusBorderColor} inset,
        0px -1.5px ${focusBorderColor} inset,
        -1.5px 0px ${focusBorderColor} inset;
      border-top-right-radius: 2px;
      border-bottom-right-radius: 2px;
    }
  `
}

export default function Home() {
  // Which rows are marked (selected)
  const [marked, setMarked] = useState<string[]>([])

  const rowSelection = React.useMemo(
    () => ({
      selectedRowKeys: marked,
      onChange: (keys: React.Key[], rows: Row[]) => {
        setMarked(keys as string[])
      },
      getCheckboxProps: (record: Row) => ({
        name: record.name,
      }),
    }),
    [marked]
  )

  const [data, setData] = useState<Row[]>([])

  // Which row is focused (under cursor) right now
  const [focused, setFocused] = useState<{ index: number; name: string } | null>(null)

  // Call this when rows are added or removed
  const recalcFocused = (data: Row[]) => {
    // If this was the last row, we say goodbye
    if (data.length === 0) {
      setFocused(null)
      return
    }
    // If there was no focused item before, we choose the first one
    if (!focused) {
      setFocused({ index: 0, name: data[0].name })
      return
    }
    // If there was a focused item, and it's still there (name-wise), we recalc its index. Otherwise we preserve the index and choose whatever row had that index
    let newIndex = data.findIndex((row) => row.name === focused.name)
    if (newIndex === -1) newIndex = R.clamp(0, data.length - 1, focused.index)
    setFocused({ index: newIndex, name: data[newIndex].name })
  }

  // Call this when rows are changed or removed
  const recalcMarked = (data: Row[]) => {
    setMarked(marked.filter((item: string) => data.some((row) => row.name === item)))
  }

  const load = () => {
    invoke('load')
      .then((data: any) => {
        setData(data)
        recalcFocused(data as Row[])
        recalcMarked(data as Row[])
      })
      .catch((err) => {
        notification.open({
          message: 'Error while loading the data',
          description: err.toString(),
          type: 'error',
        })
      })
  }

  const kill = () => {
    const namesToKill = focused && marked.length === 0 ? [focused.name] : marked
    if (namesToKill.length === 0) return
    invoke('kill', { names: namesToKill })
      .then(() => {
        load()
      })
      .catch((err) => {
        notification.open({
          type: 'error',
          message: 'Error while killing the memos',
          description: err.toString(),
        })
      })
  }

  const merge = () => {
    if (marked.length < 2) return
    invoke('merge', { names: marked })
      .then(() => {
        load()
      })
      .catch((err) => {
        notification.open({
          type: 'error',
          message: 'Error while merging the memos',
          description: err.toString(),
        })
      })
  }

  const mark = () => {
    if (!focused) return
    if (marked.includes(focused.name)) {
      setMarked((marked) => marked.filter((x) => x !== focused.name))
    } else {
      setMarked((marked) => [...marked, focused.name])
    }
  }

  const unmarkAll = () => {
    setMarked([])
  }

  const focusNext = () => {
    if (!focused || data.length < 1 || focused.index === data.length - 1) return
    const newFocused = { index: focused.index + 1, name: data[focused.index + 1].name }
    setFocused(newFocused)
    scrollIntoView(document.querySelector(`tr[data-row-key="${newFocused.name}"]`)!, {
      scrollMode: 'if-needed',
    })
  }

  const focusPrev = () => {
    if (!focused || data.length < 1 || focused.index === 0) return
    const newFocused = { index: focused.index - 1, name: data[focused.index - 1].name }
    setFocused(newFocused)
    scrollIntoView(document.querySelector(`tr[data-row-key="${newFocused.name}"]`)!, {
      scrollMode: 'if-needed',
    })
  }

  const copy = () => {
    const namesToCopy = focused && marked.length === 0 ? [focused.name] : marked
    if (namesToCopy.length === 0) return
    const result = contentToHtml(
      data
        .filter((row) => namesToCopy.includes(row.name))
        .map((row) => row.content)
        .join('\n\n')
    )
    copyToClipboard(result, { format: 'text/html' })
    notification.open({
      message: 'Copied!',
      type: 'success',
    })
  }

  const play = () => {
    const namesToPlay = focused && marked.length === 0 ? [focused.name] : marked
    if (namesToPlay.length === 0) return
    invoke('open', { name: namesToPlay.join(',') })
  }

  const [rewordModalOpen, setRewordModalOpen] = useState(false)
  const rewordEditorRef: React.RefObject<TiptapMethods> = React.useRef(null)
  const rewordModal = (
    <Modal
      width="60vw"
      open={rewordModalOpen}
      onCancel={() => setRewordModalOpen(false)}
      onOk={() => {
        if (!focused) return
        invoke('set_content', {
          name: focused.name,
          newContent: rewordEditorRef.current!.getContent(),
        }).then(() => {
          setRewordModalOpen(false)
          load()
        })
      }}
    >
      {focused && (
        <>
          <h3>{focused.name}</h3>
          <Tiptap content={data[focused.index].content} ref={rewordEditorRef} />
        </>
      )}
    </Modal>
  )
  const reword = () => {
    if (!focused) return
    setRewordModalOpen(true)
  }

  // Do a load on start (probably ok to ignore the hook warning?)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  for (const [key, action] of [
    ['m', mark],
    ['k', kill],
    ['u', merge],
    ['c', copy],
    ['Space', play],
    ['e', reword],
    ['Escape', unmarkAll],
    ['ArrowDown', focusNext],
    ['ArrowUp', focusPrev],
  ] satisfies [string, () => void][]) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useHotkeys(
      key,
      (event) => {
        event.preventDefault()
        action()
      },
      { enabled: !rewordModalOpen }
    )
  }

  const [windowWidth, windowHeight] = useWindowSize()

  return (
    <>
      <Head>
        <title>Memos</title>
      </Head>
      <main>
        {rewordModal}
        <Space
          direction="vertical"
          size="large"
          style={{ width: '100%', padding: '1rem', height: '95vh' }}
        >
          <Space direction="horizontal" size="middle">
            <Space.Compact block>
              <Button type="dashed" onClick={mark}>
                [M] Mark
              </Button>
              <Button onClick={copy}>[C] Copy</Button>
              <Button danger onClick={kill}>
                [K] Kill
              </Button>
              <Button onClick={merge}>[U] Merge</Button>
              <Button onClick={reword}>[E] Reword</Button>
              <Button>[L] Label</Button>
              <Button onClick={play}>[Space] Play</Button>
            </Space.Compact>
          </Space>
          <Space direction="vertical" size="small">
            <Typography.Text style={{ margin: 0 }} type="secondary">
              Total: {data.length}
              {marked.length > 0 && `, marked: ${marked.length}`}
            </Typography.Text>
            <style>
              {/* Highlighting by setting/unsetting classes is too slow. We don't want to rerender the table when moving the focus. So we generate a CSS string instead.
               */}
              {focused ? focusedMemoRowStyle(`tr[data-row-key="${focused.name}"]`) : ''}
            </style>
            {React.useMemo(
              () => (
                <Table
                  className={styles.table}
                  columns={[
                    {
                      title: 'File',
                      dataIndex: 'name',
                      width: '15%',
                      render: (value: string) =>
                        R.intersperse(
                          <br />,
                          value.split(',').map((s, i) => <span key={i}>{s}</span>)
                        ),
                    },
                    {
                      title: 'Content',
                      dataIndex: 'content',
                      width: '70%',
                      className: styles.tableContent,
                      render: contentToReact,
                    },
                    { title: 'Label', dataIndex: 'label', className: styles.monospace },
                  ]}
                  rowKey="name"
                  dataSource={data}
                  size="small"
                  scroll={{ y: windowHeight - 175 }} // not great (TODO use 'sticky' attr instead?)
                  pagination={false}
                  rowSelection={rowSelection}
                  onRow={(record, rowIndex) => {
                    return {
                      onClick: (event) => {
                        if (!R.isNil(rowIndex)) setFocused({ index: rowIndex, name: record.name })
                      },
                    }
                  }}
                />
              ),
              [data, rowSelection, windowHeight]
            )}
          </Space>
        </Space>
      </main>
    </>
  )
}
