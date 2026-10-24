### 1. Universal Motor (Final 2023 Q1 — Question Bank Pages 7 & 12 [Mark: 03])

**Q1: Define universal motor. Differentiate universal motor from a DC series motor and also mention its applications.**

*   **Definition:** A **Universal Motor** is a specially designed fractional-horsepower **series-wound commutator motor** that can operate on **either a DC supply or a single-phase AC supply** at approximately the same speed and power output.

| Feature | Universal Motor (AC/DC Series Motor) | Ordinary DC Series Motor |
| :--- | :--- | :--- |
| **1. Core Lamination** | **Entire magnetic path (stator yoke, poles, and rotor)** is heavily laminated to minimize AC eddy-current and hysteresis losses. | Only the rotor is laminated; stator yoke and poles are often solid steel (would overheat on AC). |
| **2. Field Winding Turns** | Has **fewer field turns** (with a low-reluctance, larger pole area) to keep AC inductive reactance drop ($I X_f$) low and power factor high. | Has more field turns (which would cause a huge $I X_f$ voltage drop and poor power factor on AC). |
| **3. Armature & Compensating Windings** | Has **more armature conductors** (to maintain torque with fewer field turns) and often includes **compensating windings** to cancel AC reactance sparking. | Standard armature turns; rarely uses compensating windings in small ratings. |
| **4. Brushes** | Uses **high-resistance carbon brushes** to suppress severe AC transformer-EMF sparking in shorted coils during commutation. | Uses lower-resistance carbon/graphite brushes. |

---

### 2. Stepper Motor (Final 2024 Q0 & Final 2022 Q3 — Question Bank Page 12 [Marks: 03])

**Q2: What is a stepper motor? Briefly describe its operation and applications. Draw the truth table and corresponding applied voltage waveforms to make the stepper motor step $30^\circ$.**

*   **Definition:** A **Stepper Motor** is a brushless, synchronous electromechanical device that converts **digital electrical voltage pulses** into fixed, discrete **mechanical angular steps** of its rotor shaft (used for precise open-loop position and speed control).
*   **Brief Operation (3 Lines):**
    1.  The stator contains multipole phase windings ($a, b, c$) excited sequentially by an electronic DC pulse driver, while the rotor is either a permanent magnet or a toothed soft-iron core (variable reluctance).
    2.  By switching the DC pulses from one stator phase to the next in sequence, the stator magnetic field steps around the air gap, causing the rotor to rotate in exact angular increments ($\theta_{\text{step}} = \frac{2}{P}\theta_e$).
*   **Applications:**
    1.  **CNC Machines, 3D Printers, and Laser Cutters** (precise $X\text{-}Y\text{-}Z$ tool positioning).

*   **Truth Table & Waveforms for a $30^\circ$ Mechanical Step ($\theta_m = 30^\circ$):**
    For a standard **3-phase stator ($a, b, c$) with a 4-pole rotor** ($\theta_m = \frac{2}{P}\theta_e = \frac{1}{2}\theta_e$, where each $60^\circ$ electrical step produces a **$30^\circ$ mechanical step** in full-step mode; *or for a 2-pole rotor in half-step mode*):

| Pulse / Step # | Phase $a$ Voltage ($V_a$) | Phase $b$ Voltage ($V_b$) | Phase $c$ Voltage ($V_c$) | Electrical Angle ($\theta_e$) | Mechanical Rotor Angle ($\theta_m$, 4-Pole) |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | $+V$ | $0$ | $0$ | $0^\circ$ | **$0^\circ$** |
| **2** | $0$ | $0$ | $-V$ | $60^\circ$ | **$30^\circ$** |
| **3** | $0$ | $+V$ | $0$ | $120^\circ$ | **$60^\circ$** |
| **4** | $-V$ | $0$ | $0$ | $180^\circ$ | **$90^\circ$** |
| **5** | $0$ | $0$ | $+V$ | $240^\circ$ | **$120^\circ$** |
| **6** | $0$ | $-V$ | $0$ | $300^\circ$ | **$150^\circ$** |
| **7** | $+V$ | $0$ | $0$ | $360^\circ$ | **$180^\circ$** |

*   *(Note: If your class used a **2-pole rotor ($\theta_m = \theta_e$)** to get $30^\circ$ steps via **Half-Stepping**, simply insert the 2-phase-ON intermediate rows between the rows above: e.g., at $30^\circ$: $V_a = +V, V_b = 0, V_c = -V$; at $90^\circ$: $V_a = 0, V_b = +V, V_c = -V$, etc.!)*
*   **How to Sketch the Applied Voltage Waveforms ($V_a, V_b, V_c$ vs. Time/Steps):**
    Draw 3 horizontal time axes stacked vertically for **$V_a(t)$, $V_b(t)$, and $V_c(t)$** marked with steps $1, 2, 3, 4, 5, 6$:
    *   On **$V_a$**: Draw a rectangular pulse of height $+V$ during Step 1, $0$ for Steps 2–3, and $-V$ during Step 4.
    *   On **$V_b$**: Draw $+V$ during Step 3, and $-V$ during Step 6 ($0$ elsewhere).
    *   On **$V_c$**: Draw $-V$ during Step 2, and $+V$ during Step 5 ($0$ elsewhere).

---

### 3. Capacitor-Start and Run Motor (Final 2023 Q2 — Question Bank Page 12 [Mark: 02])

**Q3: Explain the functions of the capacitor in a capacitor-start and run motor.**

*   **Exam Answer (3 Crisp Points):**
    1.  **Makes the Motor Self-Starting (Phase Splitting):** A single-phase winding alone creates only a pulsating magnetic field ($0$ starting torque). Connecting a capacitor in series with the auxiliary winding makes the auxiliary current ($I_{\text{aux}}$) **lead** the main winding current ($I_{\text{main}}$) by nearly **$90^\circ$**, creating a **two-phase rotating magnetic field** that makes the motor self-starting with **high starting torque**.
    2.  **Improves Running Power Factor & Efficiency:** Keeping the run capacitor permanently in series with the auxiliary winding during normal running supplies reactive magnetizing current locally, which **raises the motor's running power factor (close to unity) and increases full-load efficiency**.

---

### 4. Bonus: The Two 2019 AC Fundamental Questions at the Bottom of Page 12

Just so **100% of Page 12** of your Question Bank is complete:
*   **Final 2019 Q1 [Mark: 03] (Electrical vs. Mechanical Degree & Frequency):**
    *   In a $P$-pole AC machine, one complete cycle of induced voltage ($360^\circ$ electrical) occurs every time a pair of poles passes a conductor ($\frac{2}{P}$ of a mechanical revolution). Thus:
        $$\theta_e = \frac{P}{2}\theta_m$$
    *   At rotor speed $n_m\text{ rpm}$ ($\frac{n_m}{60}\text{ rev/s}$), since there are $\frac{P}{2}$ electrical cycles per mechanical revolution, the electrical frequency in $\text{Hz}$ (cycles/s) is:
        $$f = \left(\frac{P}{2}\text{ cycles/rev}\right) \times \left(\frac{n_m}{60}\text{ rev/s}\right) = \mathbf{\frac{P n_m}{120}\text{ Hz}}$$
*   **Final 2019 Q2 [Mark: 04] ($P = 4\text{ poles}$, 3-phase double-layer winding, $S = 24\text{ slots}$, $\phi = 0.022\text{ Wb}$, $n_m = 1800\text{ rpm}$):**
    *   Slot angle $\gamma = \frac{180^\circ P}{S} = \frac{180^\circ \times 4}{24} = \mathbf{30^\circ}$; Slots/pole/phase $n = \frac{S}{3P} = \frac{24}{3 \times 4} = \mathbf{2}$.
    *   **(i) Distribution Factor ($K_d$):**
        $$K_d = \frac{\sin(n\gamma / 2)}{n\sin(\gamma / 2)} = \frac{\sin(2 \times 30^\circ / 2)}{2\sin(30^\circ / 2)} = \frac{\sin 30^\circ}{2\sin 15^\circ} = \mathbf{0.966}$$
    *   **(ii) Generated Voltage per Phase ($E_{\text{ph}}$):**
        Frequency $f = \frac{P n_m}{120} = \frac{4 \times 1800}{120} = 60\text{ Hz}$. With 24 coils total ($8\text{ coils/phase}$), for $N_c$-turn full-pitch coils ($T_{\text{ph}} = 8 N_c$, $K_p = 1$):
        $$E_{\text{ph}} = 4.44 K_p K_d f \phi T_{\text{ph}} = 4.44 \times 1 \times 0.966 \times 60 \times 0.022 \times (8 N_c) = \mathbf{45.28 N_c\text{ Volts}} \quad (\text{or }\mathbf{45.28\text{ V}}\text{ for }N_c = 1)$$