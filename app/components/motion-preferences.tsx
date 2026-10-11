"use client"

import { useEffect } from "react"

export function MotionPreferences() {
  useEffect(() => {
    const root = document.documentElement
    const onPointerDown = () => { root.dataset.inputModality = "pointer" }
    const onKeyDown = (event: KeyboardEvent) => {
      if (["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        root.dataset.inputModality = "keyboard"
      }
    }

    root.dataset.inputModality = "keyboard"
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
      delete root.dataset.inputModality
    }
  }, [])

  return null
}
