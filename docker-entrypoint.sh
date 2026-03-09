#!/bin/bash
# Arrancar nginx y pipeline en paralelo
nginx &
python pipeline_server.py
