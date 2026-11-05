"""Ustawia w melspectrogram.tflite (openWakeWord) stałą długość wejścia, np. [1, 1760].

Model ma w pliku wejście [1, 1] (długość dowolna, ustawiana resize_tensor_input). Java-owy Interpreter TFLite
przygotowuje model już w konstruktorze — przy 1 próbce warstwa CONV_2D liczy ujemny rozmiar i pada
("BytesRequired number of elements overflowed"), zanim appka zdąży zrobić resizeInput.
Skrypt nadpisuje w miejscu jedną liczbę int32 kształtu wejścia (struktura pliku bez zmian).

    pip install tflite
    python melspec_dlugosc.py app/src/main/assets/melspectrogram.tflite 1760
"""
import struct
import sys

import tflite


def main(sciezka, dlugosc):
    buf = bytearray(open(sciezka, "rb").read())
    sg = tflite.Model.GetRootAsModel(buf, 0).Subgraphs(0)
    t = sg.Tensors(sg.Inputs(0))
    przed = [int(x) for x in t.ShapeAsNumpy()]
    if len(przed) != 2:
        sys.exit(f"nieoczekiwany kształt wejścia: {przed}")
    poczatek = t._tab.Vector(t._tab.Offset(4))   # pole 0 tabeli Tensor = shape:[int]; pozycja pierwszego elementu
    struct.pack_into("<i", buf, poczatek + 4, dlugosc)
    open(sciezka, "wb").write(buf)
    sg2 = tflite.Model.GetRootAsModel(buf, 0).Subgraphs(0)
    po = [int(x) for x in sg2.Tensors(sg2.Inputs(0)).ShapeAsNumpy()]
    print(f"{sciezka}: wejście {przed} -> {po}")


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]))
